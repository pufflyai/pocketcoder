# Pi client runbook

Use local Pi as the terminal for a PocketCoder workspace. Local Pi sends
messages through the relay. AgentAPI and the coding tools run in the workspace.
The server stores the conversation.

Run `bun run pcd` commands from the repository checkout. Run the candidate
launcher from its separate installation directory.

## Install and pin

Use the candidate tarballs and `packages.json` from the same source revision.
Check their SHA-256 hashes before installing. Install the SDK candidate with
the remote candidate so the bridge does not pick up another SDK release:

```sh
bun add /absolute/path/pstdio-pocketcoder-sdk-0.6.0.tgz \
  /absolute/path/pstdio-pocketcoder-remote-0.3.3.tgz
```

These are the package versions used for PC-114. Both local and remote Pi use
`0.83.0`; AgentAPI uses `0.12.2`; Bun uses `1.4.2`. The saved
[demo result](pi-bridge-demo.md) records the candidate hashes and workspace pins.
For another candidate, use its manifest rather than these version numbers.

Keep the workspace image digest and template version fixed for a session.
The checked-in `examples/templates/pi-harness.json` is a starting point. Its
placeholder image and model must be replaced before use. See the
[Pi harness guide](../examples/harnesses/pi/README.md) for image setup.

## Start the controller and connect

For an existing deployment, use its configured controller, gateway and bounded
machine key. The [setup guide](getting-started.md) explains owner bootstrap and
key issuance. Start the controller on the operator host:

```sh
bun run pcd -- server start
```

The configured template folder must contain the pinned Pi template. Its
gateway credential must belong to that workspace and expire or be revoked
when it stops. Provider and operator keys stay on the host. Do not mount them
into the workspace or put them in launch input.

In the client terminal, export `POCKETCODER_URL` and `POCKETCODER_KEY`. The key
needs `workspaces:read`, `services:relay`, and `conversations:read`.
Attachments need `attachments:write`. Creating and canceling workspaces also
need `templates:read`, `workspaces:create`, and `workspaces:cancel`.

```sh
bun run pcd -- workspaces create --template pi-harness --version 1.1.0 \
  --external-id pi-demo --wait --json

# Use the id returned above. Run from the directory where you installed the candidate.
export POCKETCODER_WORKSPACE_ID=<workspace-id>
bun node_modules/@pstdio/pocketcoder-remote/dist/bin.js
```

Use your generated template version if it differs from `1.1.0`.
Ask the agent to write a unique marker to `/workspace/pi-demo.txt`, then ask
it to read that file. Verify the file in the remote workspace. Local Pi has
no coding tools; it only reads local files when you attach them explicitly.

## Disconnect, reconnect and interrupt

Quit Pi during a running reply with `/quit`. The plain launcher disconnects
without canceling the workspace or interrupting the remote turn. Launch it
again with the same workspace ID. It loads the durable server conversation.
Wait for a running turn to finish before sending a follow-up. Do not send the
same accepted prompt again. Pi's local session storage is disabled.

Press Escape to stop a turn. The template must declare `agent.interruptKeys`;
the Pi harness declares Escape. After the agent is ready, send another prompt.
Switching workspaces also interrupts an active turn. Quitting only disconnects.

For an attachment, type `/attach /absolute/path/report.txt`, then send the
next message. Or include `@./report.txt` in the message. The bridge uploads
the bytes through the attachment API before sending the prompt. The remote
agent receives a path under `$HOME/.pcd/attachments`. A failed upload leaves
explicit queued files available for another attempt.

## Preserve and resume

The plain launcher has no resume callback. A preserved workspace needs an
explicit restore path and fresh bootstrap input. For a persistence-enabled
template, an operator can restore the latest checkpoint and connect to the
returned workspace ID:

These operator steps need `workspaces:preserve` and `workspaces:restore`.
Checkpoint inspection and deletion need `checkpoints:read` and
`checkpoints:delete`.

```sh
bun run pcd -- workspaces preserve --id <workspace-id> --label pi-demo
# Wait until preservation and its checkpoint are ready.
bun run pcd -- workspaces recreate --id <workspace-id> \
  --external-id pi-demo-restored --input '<fresh-workspace-scoped-input>'
```

The input is a JSON object for your template. Arrange a new gateway capability
for the restored workspace. Do not reuse the old workspace bearer. `recreate`
is an explicit operator restore; it does not make the plain launcher resume
automatically.

The existing [embedded resolver example](getting-started.md#test-automatic-resume-in-an-isolated-terminal)
supplies `WorkspaceTurnResolver`. It follows the new workspace on the next
user turn and issues a fresh gateway bearer. To try it without provider keys:

```sh
bun run example:pi:resume -- --check-model
# Save token DEMO-123
# After /quit, run the same command again and ask: Read the saved file.
# To check restored model context: Recall the original token from our conversation.
bun run example:pi:resume -- --stop
```

This fixture preserves after 60 idle seconds or `/quit`. Its host daemon stays
alive between connections. The session lasts two hours and does not survive a
host reboot or Docker reset. Use the same `--state-dir` when reconnecting or
stopping a separate session.

## Cleanup and repeatable checks

Cancel and purge only the workspace IDs owned by your demo. Purge requires
`workspaces:purge` and returns a durable operation; wait for that operation to
succeed through `GET /v1/operations/{id}`. Confirm the old workspace gateway
credential is rejected. Remove retained checkpoints for every restored
generation, then stop the demo gateway and controller.

Stop a controller or gateway only when it belongs to your demo. Leave a shared
deployment running.

```sh
bun run pcd -- workspaces cancel --id <owned-workspace-id>
bun run pcd -- workspaces purge --id <owned-workspace-id> --request-id <unique-id>
bun run pcd -- server stop
```

The isolated resume example's `--stop` command removes its own session,
database and checkpoints. The disposable UI runner below cancels its workspace
when Pi exits, so use an independent controller for reconnect testing.

```sh
bun run example:e2e:pi
bun run example:pi:resume:check
# Interactive deterministic fixture, without a paid model account:
bun examples/e2e/local.ts --harness pi --ui
```

The deterministic UI fixture supports the file-read prompt printed at startup
and `Keep working until you are interrupted.`. It is a limited test model.
Direct AgentAPI mode has no durable replay, workspace picker, managed uploads
or interruption. This acceptance covers local Docker on macOS arm64, not a
hosted provider or another architecture.
