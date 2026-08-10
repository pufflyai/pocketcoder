# `@pstdio/pocketcoder-sdk`

The Node ESM SDK for the PocketCoder control plane. It ships built JavaScript
and declarations, so consumers do not need Bun, a TypeScript loader, or access
to PocketCoder's private workspace packages.

Runtime-validated TypeScript client for the PocketCoder control-plane API. It
uses platform `fetch`, composes timeouts with caller abort signals, validates
successful and error responses, and exposes typed pagination. Retryable
transport failures and 408/425/429/5xx responses are retried only for reads or
mutations carrying an `Idempotency-Key`; configure the bounded retry count with
`maxRetries` (default `2`).

```ts
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";

const client = new PocketCoderClient({
  baseUrl: "https://pocketcoder.example.com",
  apiKey: process.env.POCKETCODER_KEY!,
});

for await (const workspace of client.workspaces.all({ state: "ready" })) {
  console.log(workspace.id, workspace.agent_state);
}

const terminal = client.terminals.connect("workspace-id");
terminal.onMessage((message) => {
  if (message.type === "output") process.stdout.write(Buffer.from(message.data_b64, "base64"));
});
```

`client.terminals.connect(id, { sessionId })` opens or reattaches an
authenticated terminal WebSocket. `client.terminals.list(id)` reads the
metadata-only terminal audit history.

Use `client.raw(path, init)` for endpoints not yet represented by a typed
resource client. API failures throw `PocketCoderError`; expired or deleted
conversation history throws the more specific `ConversationGoneError`.
