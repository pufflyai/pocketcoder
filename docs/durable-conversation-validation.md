# Durable conversation validation playbook

Use this playbook to validate the durable agent-session history and resume
changes on a clean checkout. Run commands from the repository root with Bun
1.4.2 and Docker available.

## 1. Install and run the repository gate

```sh
bun install --frozen-lockfile
bun run check
bun run typecheck
bun run test
bun run build
bun run pack:check
git diff --check
```

Expected result: every command exits zero. The database suites run against memory and disk PGlite. Runtime-driver suites
may skip when Docker or a cluster is not available.

## 2. Run the focused in-process E2E

```sh
bun test packages/server/src/testing/e2e.test.ts
```

This starts the real supervisor and harness process against the real REST and
WebSocket server with an in-memory store. It verifies workspace creation,
setup, readiness, relay conversation, harness stdout control records,
supervisor forwarding, transcript persistence, ordered history retrieval,
post-cancel retrieval, and cancellation.

Expected result: `1 pass`, with the lifecycle test named `create, setup,
harness, ready, converse, cancel`.

## 3. Run the disposable Docker/PGlite E2E

```sh
bun run example:e2e:local
```

The runner creates a temporary migrated PGlite data folder,
builds the workspace image, starts the server, creates and drives an echo
workspace through Docker, reads the durable conversation API, cancels the
workspace, and removes its temporary container and image.

Expected result: the final JSON report contains:

```json
{
  "terminalState": "canceled",
  "responseText": "echo: hello from the local E2E",
  "durableConversationMessages": 2
}
```

## 4. Run the PGlite store integration directly

```sh
bun test packages/db/src/pglite-conformance.test.ts \
  packages/db/src/modules/workspaces/conformance.test.ts \
  packages/db/src/database/crash.test.ts
```

The suites run in memory and on disk. They check transcript deduplication,
transaction rollback, migration history, writer locking and SIGKILL recovery.
The compiled fixture runs without a source checkout or adjacent database assets.

## 5. Inspect a running workspace manually

For a server and participating harness you already run, set the machine key and
workspace id, then read the first page:

```sh
export POCKETCODER_URL=http://127.0.0.1:7080
export POCKETCODER_KEY=pkt_...
export WORKSPACE_ID=<workspace-uuid>

curl --fail-with-body --silent --show-error \
  "$POCKETCODER_URL/v1/workspaces/$WORKSPACE_ID/conversation?limit=100" \
  -H "Authorization: Bearer $POCKETCODER_KEY" | jq
```

Verify that `items` are ordered by increasing `seq`, each complete harness
message appears once, and `retention.status` is `retained`. Cancel the
workspace and repeat the same GET; it must still return `200` during the
retention window.

To validate explicit deletion with a key holding `conversations:delete`:

```sh
curl --fail-with-body --silent --show-error -X DELETE \
  "$POCKETCODER_URL/v1/workspaces/$WORKSPACE_ID/conversation" \
  -H "Authorization: Bearer $POCKETCODER_KEY" -o /dev/null

curl --silent --show-error \
  "$POCKETCODER_URL/v1/workspaces/$WORKSPACE_ID/conversation" \
  -H "Authorization: Bearer $POCKETCODER_KEY" | jq
```

The DELETE returns `204`. The following GET returns `410` with error code
`conversation.deleted`; repeating DELETE remains idempotent.

## Failure triage

- No durable messages on a legacy template: confirm the harness emits one complete
  `POCKETCODER_CONVERSATION {json}` line per message on stdout and uses a stable
  `message_id` when replaying provider history.
- `403`: add `conversations:read` or `conversations:delete` to both the
  principal/key authorization path as appropriate.
- `410 conversation.expired`: increase the template's
  `persistence.conversationRetention` for future workspaces.
- `409 resume.unsupported`: inspect `error.details.reason`; only checkpoints
  declaring `conversationRestore: supported` may use the resume route.
