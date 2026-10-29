# PocketCoder Workspaces

Use a configured PocketCoder deployment as a Prompt Studio workspace provider.
This extension works independently of PocketCoder Lab.

| Extension | Purpose |
| --- | --- |
| PocketCoder Lab | Try templates, launch local controller instances, inspect test machines |
| PocketCoder Workspaces | Create workspaces using one operator-approved template and controller connection |

## Install

From a linked Prompt Studio project:

```sh
pst extensions add /absolute/path/pocketcoder/.pstdio/extensions/pocketcoder-workspaces
pst extensions check
```

This installs the extension and its package-local dependencies. It does not need
Lab, its instance directory, or a PocketCoder executable on the Prompt Studio
host. The configured deployment must already be running.

For development in this repository:

```sh
bun install --cwd .pstdio/extensions/pocketcoder-workspaces
pst extensions dev .pstdio/extensions/pocketcoder-workspaces
```

## Configure once per project

Open **Settings → Project → Extensions → PocketCoder Workspaces**.

1. In **Connections**, configure **PocketCoder** with the controller endpoint and
   its expiring operator credential. Use HTTPS outside loopback. The endpoint
   must be reachable from the Prompt Studio host.
2. Set **Workspace template** to the reviewed template name.
3. Set **Template version** to one exact published version.

The host holds the connection credential and adds it to requests. It never enters
workspace input, provider references or extension source. Grant the connection
only the template and workspace authority it needs: `templates:read`,
`workspaces:create`, `workspaces:read`, `workspaces:cancel`, `services:relay`,
and `conversations:read`, restricted to the selected template.

The template must already be published with a digest-pinned runnable image.
Changing the configured version affects new workspaces. Existing workspaces keep
their immutable template and remote identity. Keep the connection pointed at the
same deployment while those workspaces exist; changing a connection does not
migrate them. Workspace reads verify the saved Prompt Studio external identity.

## Use

Open **PocketCoder Workspaces**, then **Create workspace**. There is no template
picker or local instance control.

Leave source fields empty for the template's default setup. For a template with
reviewed Git source aliases, enter both the repository alias and revision. This
does not upload uncommitted local files.

Once ready, choose **Connect to agent**. A second connection opens its saved
session. Send prompts and follow-ups in that conversation.

```sh
pst pocketcoder-workspaces launch
pst pocketcoder-workspaces launch --repository app --revision main
pst pocketcoder-workspaces connect --workspace-id <pstdio-workspace-id>
pst pocketcoder-workspaces delete --workspace-id <pstdio-workspace-id>
```

The generic **Create workspace** form also exposes **PocketCoder workspace**.
Launch requests reject template, command and instance overrides.

## Sessions and cleanup

- Stop/cancel in the session detaches the observer. The agent may still be running.
  After reconnecting, a follow-up first observes the pending turn, then sends your new prompt.
- Delete workspace cancels the remote environment and waits for its terminal state.
  It does not purge PocketCoder's retained history or checkpoints.
- On reload, the adapter recovers its saved pending-turn marker without resending
  the prompt. The current agent transport does not provide a turn idempotency
  key. A lost submit response leaves an uncertain turn: reconnect to inspect it,
  rather than resubmitting automatically.

## Current boundary

The immutable template selects the agent and model. This release uses the
existing text conversation transport. It does not provide all local Prompt Studio
harnesses, attachments, approval forwarding, model switching, remote file
browsing, terminal UI, diff, merge, rebase or preserve/restore.

Prompt Studio Cloud and the headless worker will be implemented separately.
The cloud project must share **all project extensions**, their settings,
commands, state, files and updates, with authorized agent access and extension
editing. A managed worker/image can then run the existing local harness adapters.
This extension split makes no cloud requests and introduces no cloud credentials.

## Validate

```sh
bun run --cwd .pstdio/extensions/pocketcoder-workspaces typecheck
bun run test:extensions
pst extensions check .pstdio/extensions/pocketcoder-workspaces
```

The controller tests build a real Docker echo agent and use a real compiled
PocketCoder controller. They cover pinned launches, ownership/provider isolation,
idempotent creation, follow-up, reload/reattach and deletion.
