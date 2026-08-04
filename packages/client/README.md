# `@pstdio/pocketcoder-client`

Runtime-validated TypeScript client for the PocketCoder control-plane API. It
uses platform `fetch`, composes timeouts with caller abort signals, validates
successful and error responses, and exposes typed pagination. Retryable
transport failures and 408/425/429/5xx responses are retried only for reads or
mutations carrying an `Idempotency-Key`; configure the bounded retry count with
`maxRetries` (default `2`).

```ts
import { PocketCoderClient } from "@pstdio/pocketcoder-client";

const client = new PocketCoderClient({
  baseUrl: "https://pocketcoder.example.com",
  apiKey: process.env.POCKETCODER_KEY!,
});

for await (const workspace of client.workspaces.all({ state: "ready" })) {
  console.log(workspace.id, workspace.agent_state);
}
```

Use `client.raw(path, init)` for endpoints not yet represented by a typed
resource client. API failures throw `PocketCoderError`; expired or deleted
conversation history throws the more specific `ConversationGoneError`.
