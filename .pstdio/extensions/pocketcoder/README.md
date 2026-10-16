# PocketCoder Lab

Launch local PocketCoder instances, create agent machines for an instance, and connect through native pstdio workspaces and sessions. This repo extension replaces `pocketcoder-monitor`.

For normal workspace provisioning, install [PocketCoder Workspaces](../pocketcoder-workspaces/README.md). It uses a host-managed controller connection and one configured template version. Both extensions work independently. Lab keeps the existing `pocketcoder.pocketcoder` identity, CLI namespace, page paths and provider references so existing test machines and sessions still resolve.

## Setup

Use pstdio 0.40.0 or later with extension API 0.1.1, Docker Engine, and a PocketCoder 1.0 executable. Stable 0.x binaries do not have the required embedded database and private admin socket.

From the 1.0 integration checkout:

```sh
bun install
bun install --cwd .pstdio/extensions/pocketcoder
bun run build:native
pst extensions dev .pstdio/extensions/pocketcoder
```

The extension keeps its own dependencies and `bun.lock`, so the root `bun install` does not install them. Install them before you run the root typecheck or tests.

Use the absolute path to `out/native/pocketcoder` in the launch form, or install a tested 1.0 candidate as `pocketcoder` on PATH. The extension does not download or update executables.

## Dashboard

1. Open **PocketCoder Lab** in project navigation. The main table lists agent templates from `.pstdio/templates/pocketcoder`. Ask an agent to write prepared JSON or YAML manifests there, then click the small **Refresh** button. The table shows name, version, description, file and format issues. It reads project files even before a local service exists.
2. Click the small **Launch instance** button. Choose a listed template, enter an instance name and the 1.0 executable path. Launch publishes only that selected manifest; the service validates the complete template. A refused publication stops and removes the new instance.
3. The **Local service connection** panel shows each configured instance. **Connected** means an authenticated service request succeeded. **Unreachable** means it failed, including when a controller process exists but its HTTP listener cannot be reached. **Key expired** means its private owner key needs renewal. With no instances, the panel shows **Local service disconnected**. Refresh checks again. Select an instance row to open its machines.
4. Open the instance row. Click **Import templates** if needed. Templates must use immutable, locally available images. For a coding agent, use your deployment's template and workspace-scoped model gateway. Do not put a provider API key in a template or machine input.
5. Click **Launch machine** and choose a template version. The command creates a pstdio workspace using the **PocketCoder agent machine** provider. Its state starts as provisioning. The instance table shows its status; refresh while it starts.
6. Open the instance in **PocketCoder Lab** and refresh if needed. Use the machine row's **Connect to agent** action once it is ready. This opens a native session. Enter a prompt, then use the same conversation for follow-up messages. Connecting again reopens its saved PocketCoder session.
7. Use **Delete machine** to cancel its execution and remove the pstdio workspace. It waits for PocketCoder to stop the machine. PocketCoder retains its own workspace record and audit history; this action does not purge stored conversations or checkpoints.
8. Stop the instance from its row after deleting or cancelling its active machines. **Start / renew key** restarts it or issues a fresh 24-hour host key. Instance data remains on the host.

Cancelling a session disconnects its observer. It does not stop the machine or interrupt an agent already running. Use Delete machine to end the execution. Attachments, approvals, model switching, remote files, diff, merge, rebase, and remote terminal UI are not supplied by this extension. The agent and model are selected by the immutable template.

## CLI

```sh
pst pocketcoder templates catalog
pst pocketcoder instances launch --name local --binary /absolute/path/pocketcoder --template .pstdio/templates/pocketcoder/my-agent.json
pst pocketcoder instances choices
pst pocketcoder templates import --instance <instance-id> --directory /absolute/path/templates
pst pocketcoder templates choices --instance <instance-id>
pst pocketcoder machines launch --instance <instance-id> --template <name>@<version>
pst pocketcoder machines connect --workspace-id <pstdio-workspace-id>
pst pocketcoder machines delete --workspace-id <pstdio-workspace-id>
pst pocketcoder instances stop --instance-id <instance-id>
pst pocketcoder instances start --instance-id <instance-id>
```

The generic Create workspace form also exposes the provider. It currently requires instance ID, template name, and optional version as text. The guided Launch machine command has dynamic choices.

## Write a template with an agent

Save reviewed `pocketcoder.dev/v1alpha1` Template manifests as `.json`, `.yaml` or `.yml` files under `.pstdio/templates/pocketcoder`. Subfolders are supported. Use the existing manifest format in `examples/templates` as a reference, then replace example image pins and agent settings with working deployment values. An example manifest is not a ready coding agent.

Every manifest needs `metadata.name` and `spec.version` to appear in the picker. The catalog shows those fields; the service checks the full manifest on launch, including the immutable image digest. Use a new version when changing a published template. Credentials in a machine must be workspace-scoped and expire with it. Keep provider and operator keys outside the project and templates. This release connects to local instances; deployed environment selection is later work.

## Data and credentials

Each project keeps instances under `~/.local/share/pocketcoder-pstdio/<project-id>/<instance-id>/`. Every instance has its own embedded database, storage, process state, operator listener, and agent listener. Operator HTTP binds to loopback. The agent listener is separate and reachable by Docker through `host.docker.internal`.

Instance folders are private (0700); metadata and owner-key files are 0600. Owner keys expire after 24 hours. They stay outside project files, provider references, command results, and machine mounts. The caller's `.env` and PocketCoder settings do not carry into another instance. Instances continue running after the pstdio application closes. Reopen pstdio to reconnect or stop them.

## Validation and host gaps

```sh
bun run test:extensions
bun run --cwd .pstdio/extensions/pocketcoder typecheck
pst extensions check
```

The extension tests use the real compiled controller and a real Docker echo agent. They check instance isolation, key expiry, readiness, idempotent machine creation, agent turns, follow-up, cancellation, and saved history. The full repository check, typecheck, and test commands include this extension.

The project's Notes extension contains **PocketCoder 1.0 — pstdio workbench gaps** (note `0e1602e9-eb97-4d8f-a4ee-cd9a44229684`). It records the text-only workspace-provider form, remote file/terminal contracts, session controls, and native workspace capability handling needed for later work. The installed extension smoke test passes on pstdio 0.43.0; it covers the initial instances page. The Docker tests cover the agent transport and machine lifecycle.
