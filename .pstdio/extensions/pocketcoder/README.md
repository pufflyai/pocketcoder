# PocketCoder 1.0 for Prompt Studio

Launch local PocketCoder instances, create agent machines for an instance, and connect through native pstdio workspaces and sessions. This repo extension replaces `pocketcoder-monitor`.

## Setup

Use pstdio 0.40.0 or later with extension API 0.1.1, Docker Engine, and a PocketCoder 1.0 executable. Stable 0.x binaries do not have the required embedded database and private admin socket.

From the 1.0 integration checkout:

```sh
bun install
bun run build:native
pst extensions dev .pstdio/extensions/pocketcoder
```

Use the absolute path to `out/native/pocketcoder` in the launch form, or install a tested 1.0 candidate as `pocketcoder` on PATH. The extension does not download or update executables.

## Dashboard

1. Open **PocketCoder** in project navigation. Click **Launch instance**. Give it a name and the 1.0 executable path. You can also supply a prepared agent template folder.
2. Open the instance row. Click **Import templates** if needed. Templates must use immutable, locally available images. For a coding agent, use your deployment's template and workspace-scoped model gateway. Do not put a provider API key in a template or machine input.
3. Click **Launch machine** and choose a template version. The command creates a pstdio workspace using the **PocketCoder agent machine** provider. Its state starts as provisioning. The instance table shows its status; refresh while it starts.
4. Open the instance in **PocketCoder** and refresh if needed. Use the machine row's **Connect to agent** action once it is ready. This opens a native session. Enter a prompt, then use the same conversation for follow-up messages. Connecting again reopens its saved PocketCoder session.
5. Use **Delete machine** to cancel its execution and remove the pstdio workspace. It waits for PocketCoder to stop the machine. PocketCoder retains its own workspace record and audit history; this action does not purge stored conversations or checkpoints.
6. Stop the instance from its row after deleting or cancelling its active machines. **Start / renew key** restarts it or issues a fresh 24-hour host key. Instance data remains on the host.

Cancelling a session disconnects its observer. It does not stop the machine or interrupt an agent already running. Use Delete machine to end the execution. Attachments, approvals, model switching, remote files, diff, merge, rebase, and remote terminal UI are not supplied by this extension. The agent and model are selected by the immutable template.

## CLI

```sh
pst pocketcoder instances launch --name local --binary /absolute/path/pocketcoder
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

The project's Notes extension contains **PocketCoder 1.0 — pstdio workbench gaps** (note `8b044b06-b688-4229-94a3-f267a5bdb7fc`). It records the unsupported dynamic workspace-provider form, the installed CLI's smoke-test setup failure, remote file/terminal contracts, unsupported session controls, and native workspace capability handling needed for later work.
