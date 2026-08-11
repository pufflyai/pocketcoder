# `@pstdio/pocketcoder-sdk`

The Node ESM SDK for the PocketCoder control plane. It ships built JavaScript
and declarations, so consumers do not need Bun, a TypeScript loader, or access
to PocketCoder's private workspace packages.

Requires Node 22.19 or newer. Install it with Bun:

```sh
bun add @pstdio/pocketcoder-sdk
```

Use the SDK from a trusted backend. Do not put a PocketCoder API key in browser
code or inside a workspace. The SDK uses platform `fetch`, combines its timeout
with caller cancellation, validates successful and error responses, and
provides typed pagination. Retryable transport failures and 408/425/429/5xx
responses are retried only for reads or mutations carrying an
`Idempotency-Key`. Set the bounded retry count with `maxRetries` (default `2`).

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

## Resolve one user turn after preservation

Create one long-lived `WorkspaceTurnResolver` in a trusted backend. Call it
only when handling a user turn. A ready workspace is returned unchanged. A
preserved workspace is resumed through your callback, checked against the
source checkpoint, and returned only after it becomes ready.

```ts
import {
  PocketCoderClient,
  WorkspaceTurnResolver,
} from "@pstdio/pocketcoder-sdk";

const client = new PocketCoderClient({
  baseUrl: process.env.POCKETCODER_URL!,
  apiKey: process.env.POCKETCODER_KEY!,
});

const resolver = new WorkspaceTurnResolver({
  client,
  resumeWorkspace: async ({ source, attemptId, signal }) => {
    // Mint fresh workspace-scoped input. It must expire with the new workspace.
    const launchInput = await issueWorkspaceBootstrap({ signal });
    const result = await client.workspaces.resume(
      source.id,
      {
        external_id: `turn-${attemptId}`,
        launch_input: launchInput,
      },
      attemptId,
      { signal },
    );
    return result.workspace;
  },
});

export async function handleTurn(sourceWorkspaceId: string, prompt: string) {
  const { workspace } = await resolver.resolve(sourceWorkspaceId);
  await client.agent.sendMessage(workspace.id, { content: prompt });
  return { workspace_id: workspace.id };
}
```

The key needs `workspaces:read`; a callback that calls `resume()` also needs
`workspaces:restore`. Prompt relay and attachments need `services:relay` and
`attachments:write` respectively.

The resolver stores no A-to-B mapping. Return the resolved id through your
normal request or session state if a later request needs it. Canceling one
caller stops that caller's wait. It does not roll back a resume request already
accepted by the server, and another caller may join the same in-memory attempt.
Lifecycle failures use fixed messages and never expose callback errors or
launch input.
