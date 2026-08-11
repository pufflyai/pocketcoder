# @pstdio/pocketcoder-remote

A terminal UI for PocketCoder workspaces, built on the [Pi coding agent](https://github.com/badlogic/pi-mono). The coding agent and all file operations stay inside the remote workspace; this package runs Pi locally as a thin client that sends turns through PocketCoder's service relay and replays the workspace's durable conversation history.

```text
local Pi TUI → PocketCoder service relay → AgentAPI → remote coding agent
```

AgentAPI message snapshots stream into Pi while a turn is running. Each
snapshot replaces Pi's mutable partial message, so terminal rewrites render
without duplicated text; the completed message still comes from AgentAPI's
stable history. Older servers and workspace snapshots automatically use the
final-response polling path.

## Install

```sh
bun add -g @pstdio/pocketcoder-remote
```

Or run without installing: `bunx @pstdio/pocketcoder-remote`.

## Usage

```sh
POCKETCODER_URL=http://127.0.0.1:7080 \
POCKETCODER_KEY=pkt_... \
POCKETCODER_WORKSPACE_ID=<uuid> \
pocketcoder-remote [initial prompt]
```

`POCKETCODER_WORKSPACE_ID` is optional — without it, a workspace picker opens on startup.

Environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `POCKETCODER_URL` | yes* | PocketCoder server base URL |
| `POCKETCODER_KEY` | yes | Machine key (`pkt_...`) |
| `POCKETCODER_WORKSPACE_ID` | no | Workspace to attach to; omit to pick interactively |
| `POCKETCODER_AGENTAPI_URL` | no | Direct AgentAPI URL (bypasses the relay; disables history, picker, and status features) |

*Not required when `POCKETCODER_AGENTAPI_URL` is set.

The machine key needs scopes `workspaces:read`, `services:relay`, and
`conversations:read`. File attachments additionally require `attachments:write`.
The in-UI create and cancel commands use `templates:read`, `workspaces:create`,
and `workspaces:cancel`; they degrade gracefully when the key lacks them.

## Using your own Pi install

The `pocketcoder-remote` launcher is a thin wrapper: it spawns the Pi version
pinned by this package with the extension and the thin-client flags below. If
you already use Pi, you can load the extension directly instead:

```sh
POCKETCODER_URL=... POCKETCODER_KEY=... POCKETCODER_WORKSPACE_ID=... \
pi --extension node_modules/@pstdio/pocketcoder-remote/dist/extension.js \
   --provider pocketcoder-agentapi --model remote-agent --api-key local-ui \
   --no-tools --no-extensions --no-skills --no-context-files \
   --no-prompt-templates --no-session --offline
```

The flags are part of the contract, not decoration:

- `--no-session` keeps Pi from persisting a local transcript. History replay
  appends the server transcript on every attach, so a persisted local session
  would duplicate it on resume; the durable server conversation is the only
  source of truth.
- `--no-tools` (with the extension also clearing active tools) ensures the
  local Pi never reads or edits local files — the remote agent owns all
  workspace operations.
- `--provider pocketcoder-agentapi --model remote-agent` routes every turn
  through the PocketCoder relay; `--offline` and the remaining `--no-*` flags
  keep local skills, context files, and other extensions out of a session that
  a remote agent is actually driving.

Do not install the extension into `~/.pi/agent/extensions/` for everyday use:
it registers a remote provider and expects the flags above, so loading it into
a normal local coding session is not supported. This package pins
`@earendil-works/pi-coding-agent` to an exact version; running the extension
under a different Pi version is untested.

## Embed the Pi adapter with workspace resume

Products that can issue fresh workspace bootstrap input may pass the public SDK
resolver into the typed extension factory:

```ts
import { createRemoteExtension } from "@pstdio/pocketcoder-remote/extension";
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
    const launchInput = await issueWorkspaceBootstrap({ signal });
    const result = await client.workspaces.resume(
      source.id,
      { external_id: `pi-${attemptId}`, launch_input: launchInput },
      attemptId,
      { signal },
    );
    return result.workspace;
  },
});

export default createRemoteExtension({ resolver });
```

The bootstrap input must be new, workspace-scoped, and expire with the resumed
workspace. The key needs `workspaces:read`, `workspaces:restore`, and
`services:relay`; attachments also need `attachments:write`.

Resume runs only for a user turn. The adapter uploads one captured attachment
batch to the resolved workspace and retries only a verified terminal failure
before the prompt is accepted. `/attach` entries remain queued until that
acceptance point. After acceptance, relay or history failures never replay the
prompt.

If the same Pi UI is still open, it changes its local target to the resumed
workspace for later turns, status, attachments, and `/workspace-cancel`. A user
workspace switch or session shutdown wins over a late result. No full history
is replayed into that live UI, and no A-to-B mapping is stored. Canceling the
caller only stops its wait; an accepted server resume may continue.

The package launcher uses the default extension without a resolver. It does not
resume automatically. A preserved workspace therefore returns the fixed
no-handler error until an embedded product supplies the callback.

## In-UI commands

- `/workspace` — pick and switch to another ready workspace (replays its history)
- `/workspace-create` — pick a template, create a workspace, wait for ready, switch to it
- `/workspace-cancel` — cancel the current workspace (with confirmation)
- `/attach <path>` — queue a local file to upload with the next message

## File attachments

Three gestures turn local files into workspace files, all uploaded through
the PocketCoder attachment API when the turn is sent:

- paste or drop an image (stored as `pasted-image.<ext>`),
- mention a file as `@./report.pdf` (or `@"my report.pdf"` for spaces),
- queue one explicitly with `/attach <path>`.

The agent receives each file's workspace path under `$HOME/.pcd/attachments`.
If an upload fails the message is not sent, and explicit queued files remain
for the next safe attempt. With a direct AgentAPI URL
(`POCKETCODER_AGENTAPI_URL`) managed uploads are unavailable — attachment
gestures fail with an explanation while plain text keeps working.

## Behavior notes

- The server's durable conversation is the source of truth: every attach replays history from `GET /v1/workspaces/{id}/conversation`. Pi's local session persistence is disabled.
- Live text uses AgentAPI's `GET /events` stream when the workspace snapshot and protocol support it. Intermediate snapshots are never persisted.
- Local Pi coding tools are disabled; the remote agent does all the work.
- The status bar shows the workspace id, workspace state, and agent state, updated via the durable change cursor.
