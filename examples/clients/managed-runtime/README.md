# Managed runtime reference consumer

A headless TypeScript application that uses PocketCoder as its whole agent runtime
through the public SDK (`@pstdio/pocketcoder-sdk`) only. It shows what an application
keeps and what it leaves to PocketCoder.

| The application keeps | PocketCoder keeps |
| --- | --- |
| Its users and who may use which session (`BusinessAuthorization`) | Logical sessions, placement and replacement of compute |
| Stable session and request IDs, and the exact request body it sent (`IntentFile`) | Request acceptance, the queue, dispatch, cancellation and recovery |
| Its tools and instructions, inside the template image | Canonical history, durable events and retained files |
| Model spend limits, in its model gateway (agentgateway in reference deployments) | Physical capacity budgets |

The consumer has no runtime supervisor, rebinding loop, fingerprint assembler, provider
verifier or usage ledger.

## Files

- [`provision.ts`](provision.ts): one-time operator setup with an owner key: budget scopes,
  their capacity policies and an immutable execution profile.
- [`consumer.ts`](consumer.ts): sessions, files, turns, waiting, cancel and close.
- [`intents.ts`](intents.ts): the consumer's own durable record of request bodies.
- [`run.ts`](run.ts): one end-to-end run against a controller.

The end-to-end test is
[`packages/server/src/sessions/reference-consumer.test.ts`](../../../packages/server/src/sessions/reference-consumer.test.ts).
It runs this consumer against the real HTTP API and placement owner with a
deterministic local producer, so it needs no model.

## Cookbooks

### Provision authority

Use an owner key outside every workspace. Grant the installation scope once per
controller, then one opaque scope per customer or account. Each scope gets a capacity
policy: workspace starts per period, active workspaces and processes per workspace.
Provision an immutable profile that names the template digest and every scope.

### Run a turn

1. Create a session from a profile. Creating again with the same body returns it.
2. Upload files with `client.files.put`. A file is usable once `state` is `ready`.
3. Write the request body to your own durable store, then submit it. After a crash
   or a lost reply, send the identical body again. Changing it is a conflict.
4. Wait with `waitFor`: it reads the current history, follows events after its
   `eventCursor` and returns once the request is terminal and its collection settled.

A collection receipt exists even with no files. `complete` with no objects is a
successful empty result; `lost` and `partial` always carry an error. Never treat an
empty list as success.

### Reconnect

Persist the cursor of the last event you applied. Reconnect with `events({ after })`;
events are delivered at least once, so ignore resource revisions you already applied.
If the cursor has expired (`events.cursor_expired`), read a new history snapshot and
follow its `eventCursor`. A lost stream never cancels work.

### Stop work

`cancel` stops one request; `close` stops a session and rejects new requests. Both
return a receipt: `pending` until the stop has evidence, then `completed`. Retry with
the same `cancelId`. Sibling sessions keep running.

### Compute and replacement

The application never names a workspace. PocketCoder places compute when a session has
work, replaces it when its runtime ends and dispatches never-started work again under
the same IDs. Work that may have started is not resent. `resume` asks for compute
for an idle session.

### Previews

`client.sessions.openPreview(sessionId, name)` opens a preview of the session's
current compute. A `409 operation.conflict` means compute changed during the open:
retry, with a new grant id for cloud views.

## Run

```bash
POCKETCODER_URL=http://127.0.0.1:8090 POCKETCODER_KEY=<owner key> \
POCKETCODER_PRINCIPAL_ID=<execution principal> POCKETCODER_TEMPLATE_DIGEST=sha256:... \
bun examples/clients/managed-runtime/run.ts "Summarize the attached notes"
```

The controller needs `POCKETCODER_SESSION_QUEUE` and `POCKETCODER_SESSION_STOP_SECONDS`.
Business credentials (`credentialBindingId`) give each session an exclusive workspace;
the server tests cover that capacity refusal.
