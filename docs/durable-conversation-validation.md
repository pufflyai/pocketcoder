# Durable conversation validation playbook

Use this playbook to validate the durable agent-session history and resume
changes on a clean checkout. Run commands from the repository root with Bun
1.3.14 and Docker available.

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

Expected result: every command exits zero. The default test run may report the
PostgreSQL and runtime-driver suites as skipped when their disposable external
dependencies are not configured.

## 2. Run the focused in-process E2E

```sh
bun test apps/pocketcoder-server/src/e2e.test.ts
```

This starts the real supervisor and harness process against the real REST and
WebSocket server with an in-memory store. It verifies workspace creation,
setup, readiness, relay conversation, harness stdout control records,
supervisor forwarding, transcript persistence, ordered history retrieval,
post-cancel retrieval, and cancellation.

Expected result: `1 pass`, with the lifecycle test named `create, setup,
harness, ready, converse, cancel`.

## 3. Run the disposable Docker/PostgreSQL E2E

```sh
bun run example:e2e:local
```

The runner creates a temporary PostgreSQL 16 container, applies all migrations,
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

## 4. Run the PostgreSQL store integration directly

This optional focused check proves the generated migration and transcript
deduplication against PostgreSQL without building a workspace image.

```sh
docker run --detach --name pocketcoder-pc12-postgres \
  --env POSTGRES_USER=pocketcoder \
  --env POSTGRES_PASSWORD=pocketcoder \
  --env POSTGRES_DB=pocketcoder \
  --publish 127.0.0.1:55432:5432 \
  postgres:16-alpine

until docker exec pocketcoder-pc12-postgres pg_isready -U pocketcoder; do sleep 1; done

POCKETCODER_TEST_DATABASE_URL=postgres://pocketcoder:pocketcoder@127.0.0.1:55432/pocketcoder \
  bun test packages/db/src/store.test.ts

docker rm --force pocketcoder-pc12-postgres
```

Expected result: the PostgreSQL suite runs rather than skips, applies the
five-migration chain without drift, appends one message, treats a replayed
`message_id` as idempotent, and reads sequence `1` back.

## 5. Inspect a running workspace manually

For a server and participating harness you already run, set the machine key and
workspace id, then read the first page:

```sh
export POCKETCODER_URL=http://127.0.0.1:7080
export POCKETCODER_KEY=pkt_...
export PC12_WORKSPACE_ID=<workspace-uuid>

curl --fail-with-body --silent --show-error \
  "$POCKETCODER_URL/v1/workspaces/$PC12_WORKSPACE_ID/conversation?after=0&limit=100" \
  -H "Authorization: Bearer $POCKETCODER_KEY" | jq
```

Verify that `items` are ordered by increasing `seq`, each complete harness
message appears once, and `retention.status` is `retained`. Cancel the
workspace and repeat the same GET; it must still return `200` during the
retention window.

To validate explicit deletion with a key holding `conversations:delete`:

```sh
curl --fail-with-body --silent --show-error -X DELETE \
  "$POCKETCODER_URL/v1/workspaces/$PC12_WORKSPACE_ID/conversation" \
  -H "Authorization: Bearer $POCKETCODER_KEY" -o /dev/null

curl --silent --show-error \
  "$POCKETCODER_URL/v1/workspaces/$PC12_WORKSPACE_ID/conversation" \
  -H "Authorization: Bearer $POCKETCODER_KEY" | jq
```

The DELETE returns `204`. The following GET returns `410` with error code
`conversation.deleted`; repeating DELETE remains idempotent.

## Failure triage

- No durable messages: confirm the harness emits one complete
  `POCKETCODER_CONVERSATION {json}` line per message on stdout and uses a stable
  `message_id` when replaying provider history.
- `403`: add `conversations:read` or `conversations:delete` to both the
  principal/key authorization path as appropriate.
- `410 conversation.expired`: increase the template's
  `persistence.conversationRetention` for future workspaces.
- `409 resume.unsupported`: inspect `error.details.reason`; only checkpoints
  declaring `conversationRestore: supported` may use the resume route.
