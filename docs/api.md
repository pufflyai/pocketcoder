# HTTP API

Base path `/v1`, JSON only, UUIDv7-style identifiers, RFC 3339 UTC
timestamps. The generated OpenAPI document is served unauthenticated at
`GET /v1/openapi.json`; `GET /livez` is the process liveness probe and
`GET /readyz` reports database, schema, reconciliation, and coordinator readiness.

## Authentication

Every `/v1` route (except the OpenAPI document and the agent connect
endpoint) requires a machine key:

```text
Authorization: Bearer pkt_<key-id>_<secret>
```

Keys belong to principals and can be revoked instantly. By default they inherit
their principal's current scopes; an optional per-key scope set can narrow that
authorization.
Failures return the stable error envelope used everywhere:

```json
{ "error": { "code": "auth.invalid_key", "message": "…", "request_id": "uuid", "details": {} } }
```

Secret values, SQL/provider errors, and stack traces never appear in errors.

## Templates

```text
GET /v1/templates             scope templates:read   → { items: [{name, version, digest, description?, status}] }
GET /v1/templates/{name}      scope templates:read   → { name, versions: [...] }
GET /v1/warm-pools            scope admin            → { items: [...], metrics: {...} }
```

Only templates on the principal's allowlist are visible; others 404.

## Workspaces

### Create — `POST /v1/workspaces` (scope `workspaces:create`)

Requires an `Idempotency-Key` header.

```sh
curl -sS -X POST "$POCKETCODER_URL/v1/workspaces" \
  -H "Authorization: Bearer $POCKETCODER_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: onefin-task-018f6f0e" \
  --data-binary @- <<'JSON'
{
  "external_id": "your-task-uuid",
  "template": { "name": "claude-code-agent", "version": "1.0.0" },
  "launch_input": { "bootstrap_code": "opaque-single-use-value" },
  "source": { "kind": "git", "repository": "app", "revision": "main" },
  "metadata": { "source": "backend" }
}
JSON
```

```json
{
	"external_id": "your-task-uuid",
	"template": { "name": "claude-code-agent", "version": "1.0.0" },
	"launch_input": { "bootstrap_code": "opaque-single-use-value" },
	"source": { "kind": "git", "repository": "app", "revision": "main" },
	"metadata": { "source": "backend" }
}
```

- Repeating the same `Idempotency-Key` with the same body returns the original
  workspace (`200` instead of `201`); a different body returns
  `409 idempotency.conflict`.
- `external_id` is unique per principal among nonterminal workspaces.
- `version` omitted → current active version, resolved once into an immutable
  snapshot.
- `launch_input` is opaque, size-limited by the template, delivered to the
  harness in memory, and erased server-side at readiness.
- A full queue returns `429 capacity.queue_full`.

### Read and cancel

```text
GET  /v1/workspaces                    scope workspaces:read    filters: external_id, state, template, metadata, created_after, created_before, limit, cursor
GET  /v1/workspaces/{id}               scope workspaces:read
POST /v1/workspaces/{id}/cancel        scope workspaces:cancel  idempotent; returns the current resource
GET  /v1/workspaces/{id}/changes       scope workspaces:read    query: after (change_cursor), wait (0..30 seconds)
GET  /v1/workspaces/{id}/logs          scope logs:read          query: cursor (opaque), limit
GET  /v1/workspaces/{id}/network-events scope network:read      query: cursor (opaque), limit
```

States: `queued → provisioning → connected → ready`, followed by
`terminating → succeeded | failed | canceled | expired` or
`preserving → preserved`. Terminal states never reopen;
`reason_code` distinguishes clean exit, setup failure, registration timeout,
health failure, crash, provider loss, disconnect timeout, cancellation, and
deadline/idle expiry.

Workspace resources include `provisioning_mode`: `warm`, `cold`, or `null` before admission. This is informational; `POST /v1/workspaces` remains unchanged and callers cannot select pool behavior.

Workspace resources also include `network.state`: `disabled`, `starting`, `ready`, or `degraded`.
Network events contain the decision, transport, host, port, visible HTTP method/path (without the
query), matched rule, and reason. They never contain headers, bodies, credentials, userinfo, or
query strings. HTTPS records the CONNECT host and port only.

Every workspace resource includes a durable, monotonically increasing
`change_cursor` and an `agent_state` of `unknown`, `running`, or `stable`.
Consumers can replace status timers with a long-poll:

```sh
curl -s "$POCKETCODER_URL/v1/workspaces/$WS/changes?after=$CURSOR&wait=30" \
  -H "Authorization: Bearer $POCKETCODER_KEY"
```

The response is `{ "cursor": number, "changed": boolean, "workspace": {...} }`.
When `changed` is false, retry using the returned cursor. A state transition,
connection/health change, or agent `running`/`stable` change advances the
cursor and releases waiters. Cursors survive server restarts because they are
stored with the workspace. The single-active server uses bounded in-process
waiters after the initial durable cursor read, so an open long-poll does not
timer-poll PostgreSQL.

A failed workspace includes a bounded `failure` object directly in the
resource and lifecycle event:

```json
{
	"reason_code": "child_exit_failure",
	"log_tail": "Traceback ...\nPermissionError: /home/onefin/.pi\n",
	"log_tail_truncated": true,
	"last_log_seq": 42
}
```

The tail is at most 16 KiB, keeps UTF-8 and newline boundaries where possible,
and is diagnostic context rather than a substitute for the paginated logs
route.

`metadata` is a URL-encoded JSON object of exact string matches (up to 16
keys), for example `{"product":"onefin","tenant":"t-7","user":"u-42"}`.
It is evaluated inside the authenticated principal boundary; it is a query
constraint, never an authorization substitute. `created_after` is inclusive
and `created_before` is exclusive.

## Durable conversation history

```text
GET    /v1/workspaces/{id}/conversation   scope conversations:read    query: cursor (opaque), limit (max 200)
DELETE /v1/workspaces/{id}/conversation   scope conversations:delete  idempotent
```

The transcript is append-only durable data and remains available after the
workspace becomes terminal. It does not use the live relay. Each item has a
PocketCoder sequence, harness-stable `message_id`, `role` (`user`,
`assistant`, `system`, or `tool`), bounded text `content`, `occurred_at`, and
bounded redacted string metadata. Responses include `next_cursor` and the
retention deadline. Each workspace is capped at 100,000 messages and 50 MiB
of canonical content/metadata; each message is capped at 256 KiB.

AgentAPI-native workspaces capture complete `/messages` entries whenever the
agent is stable. The numeric AgentAPI id becomes `agentapi:<id>`, and AgentAPI's
`agent` role becomes `assistant`; replay is idempotent. Legacy harness adapters
may still write one canonical line per complete message:

```text
POCKETCODER_CONVERSATION {"message_id":"provider-7","role":"assistant","content":"Done","occurred_at":"2026-08-03T08:00:00.000Z","metadata":{"provider":"agentapi"}}
```

The supervisor validates and forwards the event over its ordered protocol;
replaying a message id is idempotent. Adapters must redact secrets and
provider-private tool/attachment data before emission. Expired transcripts
return `410 conversation.expired`; explicitly deleted transcripts return
`410 conversation.deleted` and cannot be appended again.

## Service relay

```text
GET/POST    /v1/workspaces/{id}/agent/{status|messages|message} scope services:relay
GET/POST/… /v1/workspaces/{id}/services/{service}/{path}     scope services:relay
```

Use `/agent/*` for AgentAPI-native workspaces. The generic service URL remains
as a compatibility alias for existing clients and legacy templates.

The template snapshot owns the allowlist: only declared method+path
combinations with declared query fields pass; bodies are size-capped both
ways; each route has a deadline. Requests are forwarded over the workspace's
outbound WSS connection to the loopback service (e.g. AgentAPI) — there is no
inbound network path to a workspace and no generic forwarding.

| Status | Code | Meaning |
|--------|------|---------|
| 404 | `workspace.not_found` | Unknown or unauthorized workspace |
| 409 | `workspace.not_ready` | Lifecycle does not allow relay yet |
| 410 | `workspace.terminal` | Workspace has ended |
| 413 | `relay.body_too_large` | Request or response exceeded the template limit |
| 422 | `relay.route_not_allowed` | Route/method/query not declared |
| 503 | `workspace.disconnected` | Within reconnect grace, no live supervisor |
| 504 | `relay.deadline_exceeded` | Loopback service missed the deadline |

Relay activity counts as workspace activity for the idle timeout.

## Workspace attachments

```text
PUT /v1/workspaces/{id}/attachments/{attachment_id}   scope attachments:write
```

Streams a caller-selected file into supervisor-owned storage at
`$HOME/.pcd/attachments/{attachment_id}/{name}` inside the workspace. The
attachment ID is a caller-generated UUID and the idempotency key: a retry
with identical bytes returns `200` with the existing descriptor, different
bytes return `409 attachment.conflict`, and a new upload returns `201`.

- Body: the raw file bytes, streamed in bounded acknowledged chunks over the
  supervisor connection — never through a declared service route.
- `Content-Disposition` (required): `attachment; filename="report.pdf"`; the
  RFC 5987 `filename*=UTF-8''…` form is supported for non-ASCII names.
- `Content-Length` (required): the exact byte count, at most 25 MiB
  (zero-byte files are valid).
- `Content-Type` (optional): the stored media type, defaulting to
  `application/octet-stream`.

```json
{
  "id": "c459d3dd-a9fb-439b-a090-ab849b089bca",
  "name": "report.pdf",
  "path": "/home/pocketcoder/.pcd/attachments/c459d3dd-…/report.pdf",
  "media_type": "application/pdf",
  "size_bytes": 42137,
  "sha256": "…64 hex characters…"
}
```

The supervisor sanitizes the filename, writes through a same-directory
temporary file, verifies length and digest, and atomically exposes the
completed file with `0700`/`0600` modes. The control plane persists neither
bytes nor attachment metadata; the workspace filesystem is the only store,
so attachments follow the workspace lifecycle and survive checkpoints only
when a declared persistence mount contains `$HOME/.pcd`.

Both AgentAPI message aliases accept an optional `attachment_ids` array
(1–10 unique UUIDs, at most 100 MiB of resolved content):

```json
{ "type": "user", "content": "Summarize this.", "attachment_ids": ["…"] }
```

The server resolves every ID through the connected supervisor, removes
`attachment_ids`, and appends a generated `<pocketcoder-attachments>` JSON
block to the content carrying each file's `name`, `path`, `media_type`,
`size_bytes`, and `sha256`. Any resolution failure rejects the whole message
and AgentAPI receives nothing; messages without `attachment_ids` are relayed
byte-identical. Generic custom services never resolve IDs — pass the
descriptor's `path` through the service's own documented request format.

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `attachment.invalid` | Bad UUID, headers, filename, media type, length, or id list |
| 404 | `attachment.not_found` | An ID cannot be resolved in this workspace |
| 409 | `attachment.conflict` | The ID exists with different bytes or metadata |
| 409 | `attachment.unsupported` | The connected supervisor predates workspace protocol v3 |
| 413 | `attachment.too_large` | File over 25 MiB, or a message referencing over 100 MiB |
| 503 | `attachment.interrupted` | The transfer aborted before atomic completion |

Workspace gates match the relay (`workspace.not_ready`, `workspace.terminal`,
`workspace.disconnected`), and attachment activity counts as workspace
activity for the idle timeout. Existing machine keys do not gain
`attachments:write` automatically; operators grant it explicitly.

## Attach, checkpoints, and restore

Attach is ordinary use of the existing workspace and allowlisted relay; it
creates no human session credential. It is valid only while the execution is
`ready`.

```text
POST /v1/workspaces/{id}/preserve       scope workspaces:preserve
GET  /v1/workspaces/{id}/checkpoints    scope checkpoints:read
GET  /v1/checkpoints/{id}               scope checkpoints:read
POST /v1/checkpoints/{id}/verify        scope checkpoints:read
DELETE /v1/checkpoints/{id}             scope checkpoints:delete
POST /v1/checkpoints/{id}/restore       scope workspaces:restore
POST /v1/workspaces/{id}/recreate       scope workspaces:restore
POST /v1/workspaces/{id}/resume         scope workspaces:restore
GET  /v1/operations/{id}                scope workspaces:read
GET  /v1/workspaces/{id}/outputs        scope outputs:read
```

All mutating checkpoint routes require `Idempotency-Key`. Preserve rejects new
relay work; native workspaces wait for stable AgentAPI, synchronize its final
messages, and gracefully terminate it. PocketCoder then snapshots
only template-declared mounts, verifies the manifest, and makes the source
terminal `preserved`. Restore never reopens it: a new queued workspace gets
the exact template snapshot, fresh provider and credentials, lineage fields,
and an independent writable storage allocation.

`conversation_restore` is `supported`, `filesystem_only`, or `unknown`; the
workspace also exposes `conversation_resume: {status, reason}`. `recreate`
and checkpoint `restore` are generic filesystem recovery. `resume` is the
stricter conversation operation: it selects the latest ready checkpoint,
creates a new workspace with source/checkpoint lineage only when capability is
`supported`, and otherwise returns `409 resume.unsupported` with stable
`details.reason` (`filesystem_only` or `capability_unknown`). No operation
promises process-memory, socket, in-flight request, or external side-effect
restoration.
Ready checkpoint content is immutable. Expired checkpoints are removed by the
retention sweep through the same durable delete operation.

Administrative storage inspection is available at `GET
/v1/storage/inventory`; `POST /v1/storage/prune` runs an immediate retention
sweep. The sweep also physically removes expired transcript rows while keeping
their expiry tombstones, and reports `transcripts_deleted`. Both routes require
`admin`. Inventory returns opaque IDs only, never physical paths or backend
references.

## Lifecycle events

When `POCKETCODER_EVENT_SINK_URL` is configured, every state transition is
delivered at least once from a transactional outbox with bounded exponential
backoff:

```text
POST <sink>   headers: X-PocketCoder-Event-ID, X-PocketCoder-Timestamp,
              X-PocketCoder-Signature: sha256=<HMAC(signing_key, timestamp + "." + body)>
```

Workspace events use `{ id, type: "workspace.<state>", occurred_at, workspace:
{ id, external_id, state, reason_code, agent_state, change_cursor, failure,
template, lineage, outputs } }`.
Checkpoint, restore, output, and `workspace.conversation_deleted` audit events
use the same signed outbox. Verify the signature and timestamp, deduplicate on
the event id, and poll nonterminal workspaces for convergence — delivery is
at-least-once, ordering is not guaranteed.

## Agent connect (internal)

`GET /v1/agent/connect` is the WebSocket endpoint used exclusively by
`pocketcoder-agent` inside workspaces. It authenticates with a one-time
registration secret (first connection) or a server-issued reconnect
credential — never with machine keys. Callers never use it.
