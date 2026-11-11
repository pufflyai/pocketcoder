# PocketCoder Lab

Launch local PocketCoder instances, create agent machines for an instance, and connect through native Prompt Studio sessions. Machines are controller records, separate from Prompt Studio workspaces. This repo extension replaces `pocketcoder-monitor`.

For normal workspace provisioning, install [PocketCoder Workspaces](../pocketcoder-workspaces/README.md). It uses a host-managed controller connection and one configured template version. Both extensions work independently. Lab keeps the existing `pocketcoder.pocketcoder` identity, CLI namespace and existing provider references so existing test machines and sessions still resolve.

## Setup

Use Prompt Studio extension API 0.4.0, Docker Engine, the repository-pinned Bun version, and the PocketCoder executable built from this checkout. This extension pins SDK 0.47.0-nightly.20261109030238, matching the tested host. The file-aware request routes require this implementation; use the executable built below.

From the integration checkout:

```sh
bun install
bun install --cwd .pstdio/extensions/pocketcoder
bun run build:native
pst extensions dev .pstdio/extensions/pocketcoder
```

The extension keeps its own dependencies and `bun.lock`, so the root `bun install` does not install them. Install them before you run the root typecheck or tests.

Leave the executable field blank to use this project's `out/native/pocketcoder`. Lab tries `PATH` if there is no local build. An explicit executable path is also supported; relative paths use the project folder. Run `bun run build:native` if neither exists. Lab validates the executable before saving an instance.

## Dashboard

1. Open **PocketCoder Lab**. On the first visit, it shows the instance table. Open an instance to browse its Templates and Machines. Later visits restore the last Lab page through the host's navigation history. The native breadcrumb dropdown switches instances. **Manage instances** opens the native instance table. Its toolbar can launch an instance or save a template.
2. Each instance has native **Templates** and **Machines** page tabs with native data tables. They read the controller directly, including machines launched through other clients. The selection is saved for this project.
3. Use **Save template** to add a JSON or YAML manifest to the project catalog. **Launch instance** names the instance and publishes one or more catalog templates into it. The instance's input storage limits fit the largest chosen template. The executable field is optional and uses the local build by default.
4. Use **Add template** on the Templates tab to publish another catalog template into the selected instance. **Import templates** publishes a prepared folder instead. Published versions are immutable; changed manifests need a new version.

The template decides how Lab connects to its machines; there is no connection choice at launch. A template with a session adapter gets a native PocketCoder session. Native sessions use canonical request and conversation APIs, and the Lab renders their text, tool, file, and error parts. A template without one, such as the Prompt Studio Codex template, connects through the Prompt Studio Cloud relay.
7. **Delete machine** stops execution, waits for a terminal state and removes the row from Lab. The controller retains its audit record. Failed machines remain visible with their error until dismissed.
8. The instance dropdown and instance table offer **Start instance** and **Stop instance**. Stop requires every active machine to end first. Owner keys expire after 24 hours; while the controller runs, the Lab issues a new one when the old one expires. A broken saved executable does not prevent browsing other instances; its table row shows the error.

### Prompt Studio and Codex template

Build and save the local template:

```sh
bun .pstdio/extensions/pocketcoder/src/codex-template/prepare.ts
```

Then choose it in **Launch instance** or **Add template** and launch a machine. It has no session adapter, so Lab connects through the **Prompt Studio Cloud relay**. The image pins Prompt Studio and Codex. It runs as UID 10001, with writable container storage for Prompt Studio's installed extensions. Its state is removed with the machine, which expires after one hour. The declared `pstdio` service exposes only a connection status document; it does not expose the unauthenticated dashboard or account credentials.

Cloud relay chat needs a remote device and workspace linked to this project. A safely enrolled machine declares `pstdio.device_id` and `pstdio.workspace_id` in its launch metadata. Connect checks the device is remote and online, then creates the native Codex session on it.


The template keeps Prompt Studio in the foreground and publishes its private runtime descriptor so local setup commands attach to that server. The connection status becomes available only after project setup completes. Codex starts on demand when a session uses it; the status document reports its installed version.

Run the adjacent Docker regression to build the exact image, check readiness, initialize the real Codex app server without a model call, and verify shutdown:

```sh
bun --no-env-file test ./.pstdio/extensions/pocketcoder/src/codex-template/startup.conformance.test.ts
```

This check proves local startup. A live Cloud relay session still requires safe guest enrollment from Prompt Studio; machine command tokens do not enroll Cloud devices.

## CLI

```sh
pst pocketcoder.pocketcoder templates catalog
pst pocketcoder.pocketcoder instances launch --name local --binary /absolute/path/pocketcoder --templates .pstdio/extension-storage/pocketcoder.pocketcoder/templates/my-agent.json .pstdio/extension-storage/pocketcoder.pocketcoder/templates/other-agent.json
pst pocketcoder.pocketcoder templates publish --instance <instance-id> --template .pstdio/extension-storage/pocketcoder.pocketcoder/templates/third-agent.json
pst pocketcoder.pocketcoder instances choices
pst pocketcoder.pocketcoder templates import --instance <instance-id> --directory /absolute/path/templates
pst pocketcoder.pocketcoder templates choices --instance <instance-id>
pst pocketcoder.pocketcoder machines launch --instance <instance-id> --template <name>@<version>
pst pocketcoder.pocketcoder machines connect --instance <instance-id> --machine-id <machine-id>
pst pocketcoder.pocketcoder machines relaunch --instance <instance-id> --machine-id <machine-id> --launch-input '<fresh-json>'
pst pocketcoder.pocketcoder machines resume --instance <instance-id> --machine-id <machine-id> --launch-input '<fresh-json>'
pst pocketcoder.pocketcoder machines delete --instance <instance-id> --machine-id <machine-id>
pst pocketcoder.pocketcoder instances stop --instance-id <instance-id>
pst pocketcoder.pocketcoder instances start --instance-id <instance-id> [--binary /absolute/path/pocketcoder]
```

The generic Create workspace form also exposes the provider. It currently requires instance ID, template name, and optional version as text. The guided Launch machine command has dynamic choices.

## Relaunch or resume a machine

Open a machine's row menu in **Machines**. **Relaunch machine** opens a native form and creates a fresh machine from the same template version. Its files and conversation start empty. **Resume machine** restores the latest ready checkpoint into a new machine, including saved files and conversation. Resume reports when no checkpoint exists or conversation restore is unsupported. Neither action changes the original machine.

Both actions accept a new application task ID, fresh one-time launch input, and new application metadata. An empty task ID generates a new ID. Old launch input, application metadata, and relay device/workspace IDs are never copied. Machines of relay templates need their own enrollment and device and workspace metadata. Run the action to queue the new machine. The form closes on success and stays open with an error if the action fails. Connect to the new machine when ready.

The CLI supports the same options: `--external-id`, `--launch-input`, and `--metadata`. Resume also accepts `--template-version` for a compatible version; otherwise the controller selects the checkpoint version or a compatible recovery version.

## Write a template with an agent

Save reviewed `pocketcoder.dev/v1` or legacy `pocketcoder.dev/v1alpha1` Template manifests as `.json`, `.yaml` or `.yml` files under `.pstdio/extension-storage/pocketcoder.pocketcoder/templates`. Subfolders are supported. Use the existing manifest format in `examples/templates` as a reference, then replace example image pins and agent settings with working deployment values. An example manifest is not a ready coding agent.

Every manifest needs `metadata.name` and `spec.version` to appear in the picker. The catalog shows those fields; the service checks the full manifest on launch, including the immutable image digest. Use a new version when changing a published template. Credentials in a machine must be workspace-scoped and expire with it. Keep provider and operator keys outside the project and templates. This release connects to local instances; deployed environment selection is later work.

## Run the local reference agent

Build a runnable template with a digest-pinned Docker image:

```sh
bun run build:native
bun run local:pstdio -- --output /tmp/pocketcoder-file-agent.json
```

Open **PocketCoder Lab → Save template** and paste that file. Choose **Launch instance** with the absolute `out/native/pocketcoder` path, open the new instance, then **Launch machine → file-agent@1.0.0 → Connect to agent**. Send text and attach a text file in the native session composer. The reply includes the exact file text. Other file types return their byte count and SHA-256 digest.

This reference agent echoes messages and reads files. It does not call an LLM or change a repository. It needs no model credentials. Use a reviewed file-aware coding-agent template for coding tasks.

The demo has a ten-minute workspace lifetime, a 1 MiB per-file limit, 8 MiB of staged inputs, and at most 16 files. Launch a new machine after expiry. The local instance derives input storage limits from its selected template; these are local test capacities. The build retains the Docker image so the saved template can launch again. Stop unused instances from **Instance actions**.

The harness saves a pending request before sending it. Reconnect replays the same request ID and body after a lost response. Session history comes from the controller's existing request records, including after machine deletion. The host keeps its own uploaded-file links for the native composer.

## Chat with the local Onefin agent

The local `onefin-pstdio` template runs Onefin's agent in a disposable PocketCoder machine. It uses the local Onefin backend and model gateway. The template selects the model; Prompt Studio supplies the chat interface.

Open **PocketCoder Lab**, choose **Onefin local**, open **Machines**, then open the ready machine's row menu and choose **Connect to agent**. Type messages in that native session. Connecting again opens the same saved conversation.

Create a fresh machine with the configured local helper:

```sh
bun --no-env-file .pstdio/extension-storage/pocketcoder.pocketcoder/onefin/launch.ts
```

The helper gets a one-use bootstrap from the local backend, passes its task ID and tenant metadata through **Launch machine**, waits for readiness, and creates the native chat session. It prints the machine and session IDs. Its `config.json` holds the selected instance, template, backend container and dev user. Keep standing API keys out of launch input; controller credentials stay in the private host instance folder.

This local template supports text chat. Its home and agent state use temporary memory storage. Machines expire after two hours, or after twenty idle minutes. This template has no checkpoints, so **Resume machine** explains that it is unavailable. Use the helper to create a fresh machine, or supply a new backend bootstrap and task metadata through **Relaunch machine**. The local backend's restricted controller key expires after twelve hours and needs renewal before creating or using later chats. The original Onefin deployment template is separate from this local variant.

## Data and credentials

Each project keeps instances under `~/.local/share/pocketcoder-pstdio/<project-id>/<instance-id>/`. Every instance has its own embedded database, storage, process state, operator listener, and agent listener. Operator HTTP binds to loopback. The agent listener is separate and reachable by Docker through `host.docker.internal`.

Use **Manage instances → row menu → Remove instance** to remove a stopped entry from Lab. The stopped instance's own menu offers the same action. Removal keeps its controller database, checkpoints, and session bindings on disk. It refuses a controller process that is still running, including one that fails its health check. Starting it by ID restores the entry:

```sh
pst pocketcoder.pocketcoder instances remove --instance-id <instance-id>
pst pocketcoder.pocketcoder instances start --instance-id <instance-id>
```

Machine states update from the controller's change feed. **Starting machine** and **Starting agent** are startup states; connect only when the state is **Ready**. Failed, expired, and stopped machines give recovery guidance instead of asking you to wait for readiness.

Instance folders are private (0700); metadata and owner-key files are 0600. Owner keys expire after 24 hours. They stay outside project files, provider references, command results, and machine mounts. The caller's `.env` and PocketCoder settings do not carry into another instance. Instances continue running after the pstdio application closes. Reopen pstdio to reconnect or stop them.

## Validation and host gaps

```sh
bun run test:extensions
bun run --cwd .pstdio/extensions/pocketcoder typecheck
pst extensions check
```

The extension tests use the real compiled controller and a real Docker echo agent. They check executable discovery, failed launch cleanup, broken saved executable handling, key expiry, readiness, agent turns, follow-up, cancellation, and saved history. Lifecycle tests prove that relaunch starts empty, resume restores files and conversation, both accept fresh bootstrap input, and the source stays unchanged. The full repository check, typecheck, and test commands include this extension.

The project's Notes extension contains **PocketCoder 1.0 — pstdio workbench gaps** (note `0e1602e9-eb97-4d8f-a4ee-cd9a44229684`). It records the text-only workspace-provider form, remote file/terminal contracts, session controls, and native workspace capability handling needed for later work. The installed extension smoke test passes on pstdio 0.47.0-nightly.20261109030238; it covers the initial instances page. The Docker tests cover the agent transport and machine lifecycle.
