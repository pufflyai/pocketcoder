# Bring your own UI over the relay

The local Pi client that used to live here was promoted to the published
package [`@pstdio/pocketcoder-remote`](../../../packages/remote/) — install it with
`npm install -g @pstdio/pocketcoder-remote` and run `pocketcoder-remote`, or from this
repository run `bun run example:pi:ui`.

Any client can talk to a workspace agent the same way. The relay exposes only
the routes the workspace template declares for its `agent` service — for the
`pi-harness` template that is AgentAPI's conversation API:

```text
GET  {POCKETCODER_URL}/v1/workspaces/{id}/agent/status
GET  {POCKETCODER_URL}/v1/workspaces/{id}/agent/messages
POST {POCKETCODER_URL}/v1/workspaces/{id}/agent/message   {"content": "...", "type": "user"}
```

All requests carry `authorization: Bearer <machine key>` (scope
`services:relay`). Instead of timer polling, follow the durable change cursor
(`GET /v1/workspaces/{id}/changes?after=&wait=`, scope `workspaces:read`) and
read new messages when it advances; a turn is complete when `agent_state`
returns to `stable`. Durable history is available at
`GET /v1/workspaces/{id}/conversation` (scope `conversations:read`).

See [`packages/remote/src/client.ts`](../../../packages/remote/src/client.ts) for a
dependency-free reference implementation of this loop.
