# PocketCoder Lab

Launch local PocketCoder instances, create agent machines for an instance, and connect through native pstdio workspaces and sessions. This repo extension replaces `pocketcoder-monitor`.

For normal workspace provisioning, install [PocketCoder Workspaces](../pocketcoder-workspaces/README.md). It uses a host-managed controller connection and one configured template version. Both extensions work independently. Lab keeps the existing `pocketcoder.pocketcoder` identity, CLI namespace, page paths and provider references so existing test machines and sessions still resolve.

## Setup

Use Prompt Studio extension API 0.3.1, Docker Engine, Bun 1.4.4, and the PocketCoder executable built from this checkout. This extension pins SDK 0.46.0 and was tested on host 0.47.0-nightly.20261105030234. The file-aware request routes require this implementation; use the executable built below.

From the integration checkout:

```sh
bun install
bun install --cwd .pstdio/extensions/pocketcoder
bun run build:native
pst extensions dev .pstdio/extensions/pocketcoder
```

The extension keeps its own dependencies and `bun.lock`, so the root `bun install` does not install them. Install them before you run the root typecheck or tests.

Use the absolute path to `out/native/pocketcoder` in the launch form. The extension does not download or update executables.

## Dashboard

1. Open **PocketCoder Lab** in project navigation. The main table lists agent templates from `.pstdio/extension-storage/pocketcoder.pocketcoder/templates`. Use **Save template** to paste a prepared JSON or YAML manifest. Saving the same name and version updates the catalog file. You can also write manifests there, then **Refresh**. **Remove from catalog** deletes the selected catalog file; published versions and running workspaces stay available. Published versions are immutable; use a new version for a changed published manifest. The table shows name, version, description, file and format issues. It reads project files even before a local service exists.
2. Click the small **Launch instance** button. Choose a listed template, enter an instance name and the executable path built from this checkout. Launch publishes only that selected manifest; the service validates the complete template. A refused publication stops and removes the new instance.
3. The **Local service connection** panel shows each configured instance. **Connected** means an authenticated service request succeeded. **Unreachable** means it failed, including when a controller process exists but its HTTP listener cannot be reached. **Key expired** means its private owner key needs renewal. With no instances, the panel shows **Local service disconnected**. Refresh checks again. Select an instance row to open its machines.
4. Open the instance row. Click **Import templates** if needed. Templates must use immutable, locally available images. For a coding agent, use your deployment's template and workspace-scoped model gateway. Do not put a provider API key in a template or machine input.
5. Click **Launch machine** and choose a template version. The command creates a pstdio workspace using the **PocketCoder agent machine** provider. Its state starts as provisioning. The instance table shows its status; refresh while it starts.
6. Open the instance in **PocketCoder Lab** and refresh if needed. Use the machine row's **Connect to agent** action once it is ready. This opens a native session. Enter a prompt, attach files with the native composer, then use the same conversation for follow-up messages. File uploads require an input-aware `pocketcoder.dev/v1` template with a `message` operation and verified immutable-input support. Legacy templates support text only. Connecting again reopens its saved PocketCoder session.
7. Use **Delete machine** to cancel its execution and remove the pstdio workspace. It waits for PocketCoder to stop the machine. PocketCoder retains its own workspace record and audit history; this action does not purge stored conversations or checkpoints.
8. Stop the instance from its row after deleting or cancelling its active machines. **Start / renew key** restarts it or issues a fresh 24-hour host key. Instance data remains on the host.

Cancelling a session disconnects its observer. It does not stop the machine or interrupt an agent already running. Use Delete machine to end the execution. Approvals, model switching, a remote file browser, diff, merge, rebase, and remote terminal UI are not supplied by this extension. Uploaded files are immutable request inputs, made available to the agent for that turn. The agent and model are selected by the immutable template.

## CLI

```sh
pst pocketcoder.pocketcoder templates catalog
pst pocketcoder.pocketcoder instances launch --name local --binary /absolute/path/pocketcoder --template .pstdio/extension-storage/pocketcoder.pocketcoder/templates/my-agent.json
pst pocketcoder.pocketcoder instances choices
pst pocketcoder.pocketcoder templates import --instance <instance-id> --directory /absolute/path/templates
pst pocketcoder.pocketcoder templates choices --instance <instance-id>
pst pocketcoder.pocketcoder machines launch --instance <instance-id> --template <name>@<version>
pst pocketcoder.pocketcoder machines connect --workspace-id <pstdio-workspace-id>
pst pocketcoder.pocketcoder machines delete --workspace-id <pstdio-workspace-id>
pst pocketcoder.pocketcoder instances stop --instance-id <instance-id>
pst pocketcoder.pocketcoder instances start --instance-id <instance-id>
```

The generic Create workspace form also exposes the provider. It currently requires instance ID, template name, and optional version as text. The guided Launch machine command has dynamic choices.

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

The demo has a ten-minute workspace lifetime, a 1 MiB per-file limit, 8 MiB of staged inputs, and at most 16 files. Launch a new machine after expiry. The local instance derives input storage limits from its selected template; these are local test capacities. The build retains the Docker image so the saved template can launch again. Stop unused instances from the connection panel.

The harness saves a pending request before sending it. Reconnect replays the same request ID and body after a lost response. Session history comes from the controller's existing request records, including after machine deletion. The host keeps its own uploaded-file links for the native composer.

## Data and credentials

Each project keeps instances under `~/.local/share/pocketcoder-pstdio/<project-id>/<instance-id>/`. Every instance has its own embedded database, storage, process state, operator listener, and agent listener. Operator HTTP binds to loopback. The agent listener is separate and reachable by Docker through `host.docker.internal`.

Instance folders are private (0700); metadata and owner-key files are 0600. Owner keys expire after 24 hours. They stay outside project files, provider references, command results, and machine mounts. The caller's `.env` and PocketCoder settings do not carry into another instance. Instances continue running after the pstdio application closes. Reopen pstdio to reconnect or stop them.

## Validation and host gaps

```sh
bun run test:extensions
bun run --cwd .pstdio/extensions/pocketcoder typecheck
pst extensions check
```

The extension tests use the real compiled controller and a real Docker echo agent. They check instance isolation, key expiry, readiness, idempotent machine creation, exact uploaded bytes, replay after a lost reply, agent turns, follow-up, cancellation, and saved history without client state. The full repository check, typecheck, and test commands include this extension.

The project's Notes extension contains **PocketCoder 1.0 — pstdio workbench gaps** (note `0e1602e9-eb97-4d8f-a4ee-cd9a44229684`). It records the text-only workspace-provider form, remote file/terminal contracts, session controls, and native workspace capability handling needed for later work. The installed extension smoke test passes on pstdio 0.47.0-nightly.20261105030234; it covers the initial instances page. The Docker tests cover the agent transport and machine lifecycle.
