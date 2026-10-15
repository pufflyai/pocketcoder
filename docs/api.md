# HTTP API

Base path `/v1`, JSON only, UUIDv7-style identifiers, RFC 3339 UTC
timestamps. The generated OpenAPI document is served unauthenticated at
`GET /v1/openapi.json`; `GET /livez` is the process liveness probe and
`GET /readyz` reports database, schema, reconciliation, and coordinator readiness.
It also reports unresolved content cleanup. See [verifiable cleanup](cleanup.md)
for workspace purge, principal-key administration, and isolated backup replay.

## Authentication

Every `/v1` route (except the OpenAPI document and the agent connect
endpoint) requires a machine key:

```text
Authorization: Bearer pkt_<key-id>_<secret>
```

Keys belong to principals and can be revoked instantly. Public issuance requires
explicit scopes and expiry. Effective scopes and template grants intersect the
principal's live grants on every request. A restricted key on an admin principal
does not inherit admin. Stored legacy keys with empty scopes inherit live scopes;
new public keys always have a nonempty scope set.
Failures return the stable error envelope used everywhere:

```json
{ "error": { "code": "auth.invalid_key", "message": "…", "request_id": "uuid", "details": {} } }
```

Secret values, SQL/provider errors, and stack traces never appear in errors.

## Preview and display sessions

`POST /v1/workspaces/{id}/previews/{name}` needs `previews:open`.
`POST /v1/workspaces/{id}/display` needs `display:view`; `control: true` also
needs `display:control`. Both return `{ url, expires_at }`. Preview names and
display mode come from the workspace's immutable template.

Supply `session` with one of these modes:

| Session | Use | Cookie and framing |
| --- | --- | --- |
| `{ mode: "local" }` | Loopback HTTP controller; this is the default | Host-only, HttpOnly, SameSite=Lax; framing denied |
| `{ mode: "top_level" }` | Public HTTPS view in its own tab | Secure `__Host-pc-view`, HttpOnly, SameSite=Lax; framing denied |
| `{ mode: "embedded", parentOrigin: "https://app.example.org" }` | One configured parent application | Secure `__Host-pc-view`, HttpOnly, SameSite=None, Partitioned; only the exact parent and the view itself may frame it |

The SDK accepts `{ session }` in `client.previews.open(id, name, options)` and
`client.displays.open(id, control, options)`. Mint on your application's backend;
keep its finite machine key there. Do not put a machine key in an iframe or a
workspace. The one-time URL expires after 60 seconds and exchanges its token
before any view content loads. The session ends within one hour, key expiry or
the workspace deadline. Revoke, disable and grant loss close active streams;
reconnect checks current authority.

Set `POCKETCODER_PUBLIC_VIEWS` to JSON on the controller, for example:

```json
{
  "apiOrigin": "https://api.example.org",
  "origin": "https://views.example.net",
  "parents": ["https://app.example.org"],
  "trustedIngress": ["127.0.0.1"]
}
```

The API, parent applications and public views must use different registrable
domains from the views. A registrable domain is the name a tenant can own, such
as `example.co.uk`; private public suffixes such as `github.io` also count.
Point wildcard view DNS and TLS at the controller ingress. Only listed ingress
peer addresses or ranges, such as `10.244.0.0/16`, may supply `X-Forwarded-Host`
and `X-Forwarded-Proto: https` (or `wss` for WebSocket upgrades). List a range only when network policy lets
nothing but the ingress reach the controller. Other forwarding headers cannot
select the public origin. Cookies have no Domain
attribute. Platform cookies and authorization headers never reach workspace
services. Unsafe requests and browser sockets require the exact view Origin.
The reserved display host serves trusted viewer assets only.

An embedded view first checks its cookie at a clean URL. When cookies are
blocked, it shows an explicit message and sends
`{ type: "pocketcoder.view_unavailable" }` to its bound parent. Accept this
message only when both `event.origin` equals the returned view origin and
`event.source` equals your iframe's `contentWindow`.

Always provide an **Open in a new tab** link. Point it at an authenticated route
on your application backend with `target="_blank" rel="noopener noreferrer"`.
When clicked, that route mints a fresh `top_level` session and redirects to its
one-time URL. This keeps the fallback fresh and starts a real top-level
navigation, including in browsers that block third-party cookies. Do not reuse
the iframe token or a saved fallback URL. Partitioned-cookie support varies
with browser settings; use the fallback when the cookie check fails.

Run `bun run example:e2e:embed --keep` for Chromium and Firefox with third-party
cookies blocked. The fixture uses separate HTTPS domains, real Docker Chromium
frames, and a fresh top-level fallback. It uses a temporary self-signed
certificate in its test contexts and removes its workspace afterward.

### Hosted account sessions

A managed account has its own API and view hosts. The manager returns them as
`api_origin` and `view_origin`, for example:

```text
api_origin   https://0f6c3b5e9d0a4c618f3e6b2a1c9d7e40.pocketcoder.datazine.app
view_origin  https://0f6c3b5e9d0a4c618f3e6b2a1c9d7e40.embed.kaset.dev
```

The operator sets the allowed embedding parents when creating the account. Your
backend calls the account API with its finite key; the returned view URL is on
the account's view zone:

```ts
const client = new PocketCoderClient({ baseUrl: account.api_origin, apiKey: finiteKey });
const { url } = await client.displays.open(workspaceId, false, {
  session: { mode: "embedded", parentOrigin: "https://app.example.org" },
});
// url: https://<workspace>-display.0f6c3b5e9d0a4c618f3e6b2a1c9d7e40.embed.kaset.dev/.pc/open?token=…
```

Put `url` in the iframe and keep the **Open in a new tab** fallback described
above. The PocketCoder session cookie works only on its own view host. Another
account's view zone, the API host and hosts outside the account zones do not
accept it. Removing the account's namespace removes its hosts, certificate and
DNS records, so old sessions stop working.

All accounts' view hosts share the `kaset.dev` site. A workspace page can set a
cookie for `kaset.dev` that browsers also send to other accounts' apps. Do not
rely on app cookies being private to one account until `embed.kaset.dev` is on
the Public Suffix List.

## Principals and keys

```text
GET   /v1/principals                  principals:admin → { items: [...] }
POST  /v1/principals                  principals:admin → principal (201)
GET   /v1/principals/{id}             principals:admin → principal
PATCH /v1/principals/{id}             principals:admin → principal
GET   /v1/principals/{id}/keys        keys:read → { items: [...], next_cursor }
POST  /v1/principals/{id}/keys        keys:write → { key, token } (201 or replay 200)
DELETE /v1/principals/{id}/keys/{keyId} keys:write → { revoked: true }
DELETE /v1/principals/{id}/keys       keys:write → { revoked: true }
```

Create accepts `{ name, scopes, templates }`. Patch accepts optional `scopes`,
`templates` and `disabled`; supply at least one. ID and name cannot change.
Names are unique (`principal.name_conflict`, 409). The caller cannot edit itself.
A constrained caller can only create, see or change principals within its current
scope and template grants. Stronger targets are hidden or rejected. Disable and
issuance serialize: disabling revokes all target keys before returning, and
re-enable does not restore their validity.

Key issuance accepts `{ request_id, scopes, expires_at, templates?,
managed_principal_ids? }`. Scope/template grants must fit both current caller and
target. Expiry must be in the future and cannot exceed the caller key's expiry.
Explicit owner admin may issue bounded admin or recovery keys. A
`principals:admin`-only key cannot issue keys. Recovery issuance requires exact
existing target UUIDs and only `keys:read`, `keys:write`, `workspaces:recover`.
Existing delegated keys keep their exact target grant for execution-key recovery;
they cannot mint administrative authority or target an administrative principal.

Issuance identity includes scopes, templates, expiry and target IDs. Reusing an ID
with changed input returns `idempotency.conflict` (409). Replay returns metadata
and `token: null`. To recover a lost response, list with `request_id`, revoke,
then issue a fresh request ID. Plaintext secrets never appear in inventory.
The SDK exposes `client.principals.create/list/get/update` and `client.keys`.

## Controller secrets

```text
PUT    /v1/secrets/{name}   scope secrets:write → { name, type, updated_at, retired_at }
GET    /v1/secrets          scope secrets:write → { items: [...] }
DELETE /v1/secrets/{name}   scope secrets:write → retired metadata
```

PUT accepts `{ type: "registry", value: { server, username, password } }`, up to
64 KiB. Names contain 1–128 letters, digits, dots, underscores or hyphens and
start with a letter or digit. The server encrypts values with its private data
folder key. Read APIs return metadata only. DELETE blocks future resolution;
a new PUT replaces the active configuration. Authority is checked again inside
the database transaction. Setup issuers accept
`{ type: "setup-issuer", value: { url, authorization, policy } }`. The URL must
use HTTPS without userinfo, queries or fragments. Runtime issuer types remain
unavailable. See [private-source setup](private-source.md).

A template uses `spec.imagePullSecret: "secretRef:<name>"`. Publishing such a
template also requires `secrets:write`; launching it uses the caller's normal
template grants. See [private images](templates.md#private-images).

## Templates

```text
GET /v1/templates             scope templates:read   → { items: [{name, version, digest, agent, description?, status}] }
GET /v1/templates/{name}      scope templates:read   → { name, versions: [...] }
GET /v1/warm-pools            scope admin            → { items: [...], metrics: {...} }
```

Only templates on the principal's allowlist are visible; others 404.

Each template item includes `agent: { type: string, model: string | null } | null`.
This also applies to template version details, publish and retire responses.
The object contains only the declared type and model, without commands or env.
`model` is the optional display label from `spec.agent.model`, not a claim about
the model currently running. It is `null` when omitted. Legacy `spec.harness`
templates return `agent: null`.

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
GET  /v1/workspaces/{id}/terminal-sessions scope terminal:read  query: cursor (opaque), limit
```

States: `queued → provisioning → connected → ready`, followed by
`terminating → succeeded | failed | canceled | expired` or
`preserving → preserved`. Terminal states never reopen;
`reason_code` distinguishes clean exit, setup failure, registration timeout,
health failure, crash, provider loss, disconnect timeout, cancellation, and
deadline/idle expiry.

Workspace resources include `provisioning_mode`: `warm`, `cold`, or `null` before admission. This is informational; `POST /v1/workspaces` remains unchanged and callers cannot select pool behavior.

Every workspace resource also includes the same `agent` object described under
Templates. It comes from the workspace's immutable template snapshot. Publishing
or retiring a template version does not change an existing workspace's agent
metadata. Create, list, detail, cancel and change-wait responses use this shape.

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
timer-poll the database.

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

AgentAPI-native workspaces capture accepted user input and earlier completed
`/messages` entries while the agent is running. The final assistant entry stays
pending until a read starts and finishes under the same stable health revision.
The numeric AgentAPI id becomes `agentapi:<id>`, and AgentAPI's
`agent` role becomes `assistant`; replay is idempotent. Legacy harness adapters
may still write one canonical line per complete message:

```text
POCKETCODER_CONVERSATION {"message_id":"provider-7","role":"assistant","content":"Done","occurred_at":"2026-08-03T08:00:00.000Z","metadata":{"provider":"agentapi"}}
```

Before cooperative Stop or shutdown, the supervisor waits for an older history
read and starts a fresh one before forwarding TERM. This shares the existing
termination grace period. A failed read is reported and physical termination
continues; a slow read cannot extend the deadline. KILL bypasses this final read.
Frames remain ordered on the control channel; a disconnected channel or forced
kill cannot guarantee delivery of the latest input.
The server saves transcript frames already received even if provider cleanup
finishes before queued writes. Deleted or purged history stays deleted.
Stop responses and terminal state do not acknowledge queued transcript writes;
an immediate history read can lag.
Checkpoint preparation also starts a fresh stable read within its deadline.

The supervisor validates and forwards the event over its ordered protocol;
replaying a message id is idempotent. Adapters must redact secrets and
provider-private tool/attachment data before emission. Expired transcripts
return `410 conversation.expired`; explicitly deleted transcripts return
`410 conversation.deleted` and cannot be appended again.

## Service relay

```text
GET/POST    /v1/workspaces/{id}/agent/{status|messages|message|events} scope services:relay
GET/POST/… /v1/workspaces/{id}/services/{service}/{path}     scope services:relay
```

Use `/agent/*` for AgentAPI-native workspaces. The generic service URL remains
as a compatibility alias for existing clients and legacy templates.

The template snapshot owns the allowlist: only declared method+path
combinations with declared query fields pass; bodies are size-capped both
ways; each route has a deadline. Requests are forwarded over the workspace's
outbound WSS connection to the loopback service (e.g. AgentAPI) — there is no
inbound network path to a workspace and no generic forwarding.

New AgentAPI-native workspace snapshots declare `GET /agent/events` as a
streamed `text/event-stream` response. SSE bytes remain unchanged through the
relay. Protocol v5 transports bounded chunks with one outstanding
acknowledgement; HTTP cancellation, workspace disconnect, deadlines, and the
declared cumulative byte cap cancel the supervisor's loopback fetch. Existing
snapshots and protocol v1–v4 supervisors keep the buffered routes, so remote
clients should treat `relay.route_not_allowed` and
`relay.streaming_unsupported` as signals to use `/status` and `/messages`.

| Status | Code | Meaning |
|--------|------|---------|
| 404 | `workspace.not_found` | Unknown or unauthorized workspace |
| 409 | `workspace.not_ready` | Lifecycle does not allow relay yet |
| 409 | `relay.streaming_unsupported` | Declared stream route requires a protocol-v5 supervisor |
| 410 | `workspace.terminal` | Workspace has ended |
| 413 | `relay.body_too_large` | Request or response exceeded the template limit |
| 422 | `relay.route_not_allowed` | Route/method/query not declared |
| 503 | `workspace.disconnected` | Within reconnect grace, no live supervisor |
| 504 | `relay.deadline_exceeded` | Loopback service missed the deadline |

Relay activity counts as workspace activity for the idle timeout.

## Interrupt the current turn

```text
POST /v1/workspaces/{id}/agent/interrupt   scope services:relay   no body
```

This stops the agent's current turn. The workspace, the agent process and the
conversation stay. Three actions are separate:

- **Interrupt** stops the current turn. Send a follow-up when the agent is
  `stable` again.
- **Disconnect** (closing a request or event stream) only stops watching. The
  turn keeps running.
- **Cancel** (`POST /v1/workspaces/{id}/cancel`) ends the whole workspace.

The server reads the agent status first. While a turn runs, it sends the
template's `agent.interruptKeys` to the agent's terminal through AgentAPI's raw
message type.

| Status | Body or code | Meaning |
|--------|--------------|---------|
| 200 | `{"status":"requested"}` | The keys were sent. This does not prove the turn stopped: wait for `agent_state: "stable"`. |
| 200 | `{"status":"idle"}` | The agent was already waiting for input. Nothing was sent. |
| 409 | `agent.interrupt_unsupported` | The template declares no interrupt keys. The workspace keeps running. |

The relay errors above also apply. AgentAPI has no turn ID, so an interrupt that
races with another client's new turn can stop that turn. A client that waits
for each interrupt before it sends again is safe. AgentAPI also reports
`running` until the agent's screen has been still for about 2 s, so repeating
the request in that window sends the keys again. Wait for
`agent_state: "stable"` instead of repeating it. Interruption cannot undo file
edits or tool effects that already happened, and AgentAPI saves the partial
reply as a normal agent message.

## Interactive terminal

```text
GET /v1/workspaces/{id}/terminal                 scope terminal:attach  WebSocket upgrade
GET /v1/workspaces/{id}/terminal-sessions        scope terminal:read    query: cursor (opaque), limit
```

The WebSocket route is available only for an owned, `ready` workspace whose
template snapshot declares `terminal` and whose supervisor speaks workspace
protocol v4. The client sends JSON text messages containing either bounded
base64 input or terminal dimensions; the server sends `opened`, `output`,
`closed`, and reconnect `status` messages. No request carries a command or
argv: the supervisor starts exactly the template-declared command under a PTY.

Disconnecting the client detaches without ending the process. Reconnect with
`?session=<uuid>` to reuse the same PTY and replay its bounded recent output,
including after supervisor-socket churn. Input refreshes workspace activity;
output alone does not. Idle terminals and lifecycle transitions close the PTY.

The history response contains `session_id`, `workspace_id`, `key_id`, open
and close timestamps, `duration_ms`, close reason, exit code, and byte counts.
Terminal content is never persisted. Matching `workspace.terminal_opened` and
`workspace.terminal_closed` events are emitted through the signed outbox.

| Status | Code | Meaning |
|--------|------|---------|
| 409 | `workspace.not_ready` | Workspace is not ready |
| 409 | `terminal.session_limit` | The template's live-session limit is reached |
| 410 | `workspace.terminal` | Workspace has ended |
| 422 | `terminal.not_declared` | Template did not opt into terminal access |
| 426 | `terminal.protocol_unsupported` | Supervisor predates protocol v4 |
| 503 | `workspace.disconnected` | No live supervisor connection |

## Workspace attachments

```text
PUT /v1/workspaces/{id}/attachments/{attachment_id}   scope attachments:write
```

Streams into private controller storage. `Content-Disposition` supplies a logical
filename, `Content-Length` supplies the exact size, and `X-Content-SHA256` supplies
64 lowercase hex characters. `Content-Type` defaults to `application/octet-stream`.
Zero-byte inputs are valid. Limits are explicit deployment settings; see
[immutable input storage](input-storage.md).

A new input returns `201` with an `InputObjectReference`:

```json
{
  "workspaceId": "e372d962-5cb5-4df3-bfc7-4957ce123205",
  "fileId": "c459d3dd-a9fb-439b-a090-ab849b089bca",
  "objectVersion": "sha256:<descriptor digest>",
  "name": "report.pdf",
  "mediaType": "application/pdf",
  "sizeBytes": 42137,
  "digest": "sha256:<content digest>",
  "visibility": "ready"
}
```

References contain no physical path. A same-ID/same-descriptor retry returns `200`
without consuming the body. Changed descriptors return `409 attachment.conflict`.
An in-flight owner returns `409 operation.conflict`; retry after it settles.
Capacity is reserved before body reads. Size or digest mismatch returns
`400 attachment.invalid`; per-file excess returns `413 attachment.too_large`.
Aggregate, file count or transfer exhaustion returns `507 storage.capacity_exhausted`.
Interrupted uploads return `503 attachment.interrupted`. Missing or corrupt canonical
bytes return `404 attachment.not_found` and require a new staging ID.

The workspace must be ready, owned by the caller and not being purged. A live
supervisor connection is not required. Upload activity updates the idle clock.
`attachments:write` is an explicit scope. Without configured trusted storage the
route returns `409 attachment.unsupported`.

The SDK hashes buffered bodies and sends the digest. Stream callers must supply
`sha256` before body consumption. Upload progress still reports consumed bytes.
`attachments.upload` now returns an immutable reference with `fileId`, replacing
the old workload path descriptor. CLI and remote uploads send the same digest.

AgentAPI messages with `attachment_ids` fail closed with
`409 attachment.unsupported` until a qualified immutable projection and operation
owner are installed. Messages without attachment IDs remain byte-identical.
Docker/Kubernetes projection enforcement belongs to PC-128/PC-130; staged bytes
alone do not advertise installed immutable-input execution support.

## Screenshots

`POST /v1/workspaces/{id}/display/screenshot` takes `{}` and requires
`display:view`. The workspace must be ready and declare a desktop or browser
display. A supervisor on protocol v11 captures the current display. The result
is a small output reference with `kind: "screenshot"`, `id`, `workspace_id`,
`content_type`, `bytes`, `digest` and `expires_at`. No image bytes appear in JSON.
Capture has a 10-second deadline and a 4 MiB PNG limit. At most four captures
run per controller and one per supervisor. A failed or canceled request may
have captured the display; inspect outputs before retrying.

`GET /v1/workspaces/{id}/outputs/{outputId}/content` requires `outputs:read`
and workspace ownership. It returns a private PNG download with `no-store`.
The reference also appears in the ordinary workspace outputs list.

```ts
const screenshot = await client.displays.capture(workspaceId);
const response = await client.outputs.download(workspaceId, screenshot.id);
const bytes = await response.arrayBuffer();
```

Before capture starts, the controller reserves 12 MiB plus 64 KiB from the
shared workspace, principal and instance storage quotas. This covers the
bounded image, database writes and upload staging. The full charge stays until
retention or purge removes the bytes. Limits use `POCKETCODER_MAX_RETAINED_BYTES`
and `POCKETCODER_MAX_RETAINED_BYTES_PER_PRINCIPAL`, with disk headroom checked
before admission. Excess capture returns `storage.capacity_exhausted`.

Screenshots expire after 24 hours. Expired bytes are unreadable immediately;
startup and the retention sweep delete them and release their reservations.
The admin storage prune endpoint also runs this sweep. Workspace purge deletes
screenshots with other workspace data. Publication rechecks the current key,
connection epoch and purge fence, so a late capture cannot restore deleted data.
Screenshots live in the private controller database and its backups. Restored
backups still apply retention deadlines and the existing purge journal.

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
`pocketcoder-supervisor` inside workspaces. It authenticates with a one-time
registration secret (first connection) or a server-issued reconnect
credential — never with machine keys. Callers never use it.

## Queued admission and explicit conversation outcomes

Queued workspace responses expose bounded admission reasons through `reason_code`;
see [admission feedback](admission.md). The change cursor advances when the reason
changes and the reason clears on admission. Limits and termination proof remain
unchanged.

`POST /v1/workspaces/{id}/conversation/requests` accepts a caller-owned v2 request
identity under `conversations:write`. Replays return the same receipt; conflicting
input returns 409. History includes nullable message identities and explicit facts.
See [conversation identities](conversation-identities.md) for the request fields,
producer contract and the distinction between final text and terminal outcome.
`agent_state: stable` reports input readiness, not completed model work.

## Canonical workload contracts (G0)

The `pocketcoder.dev/v1` workload schemas are available from
`@pstdio/pocketcoder-contracts`. The SDK exports their public TypeScript types:
`WorkloadTemplate`, `WorkloadTemplateSnapshot`, `InstalledWorkload`,
`WorkloadCapability`, `WorkloadLimits`, `WorkloadDeployment`, `WorkloadOperation`,
`WorkloadExecutionReference`, `WorkloadAcceptance`, `WorkloadCancel`,
`InputObjectReference`, `AcceptedInputManifest`, `ExportObjectReference`,
`WorkloadExportReference` and `CredentialSlot`.

These are contracts for the later runtime gates, not new HTTP endpoints in G0.
`POST /v1/templates` and startup import currently reject canonical workloads.
The offline validate/render commands accept them. See the
[owner map and complete example](templates.md#canonical-workload-templates).

An execution reference identifies workspace, runtime incarnation, owning process
or conversation request, and stable request ID. Acceptance freezes the caller,
template and adapter digests, operation, structured input, ordered input manifest,
and binding-set digest into one fingerprint. Transport reconnect does not change
that identity. Cancellation names the exact execution and a stable cancel ID;
workspace-wide cancellation is a separate advertised scope.

Input references identify immutable versions, logical names, media types, bytes,
digests and availability. Accepted manifests permit only unique ready objects from
the execution's workspace and incarnation. Their digest covers their exact ordered
contents. Public references carry no host or PVC paths. Export references identify
the execution and immutable objects, manifest digest, completeness/errors,
publication time and finite expiry. Collection reads retained objects; it does not
turn a live output path into evidence or control compute teardown.
An export's digest freezes its execution, ordered objects, completeness and errors.
Publication availability (`published`, `unavailable`, `expired`) is separate from
completeness (`complete`, `partial`, `lost`) and does not change that digest.

`InstalledWorkload` is trusted driver/registration evidence, never caller input.
`workloadAdmission` checks it against template requirements and deployment ceilings.
Format support from `inspectTemplateSnapshot` alone does not establish installed
capabilities. Existing process/request, transfer/output, lease and preview owners
remain responsible for enforcing these contracts; no parallel scheduler is added.
