# `@pstdio/pocketcoder-supervisor`

The supervisor that runs as PID 1 inside every PocketCoder workspace.

## Why it exists

Every workspace needs one trusted process to connect an isolated runtime to the
PocketCoder control plane. Keeping that lifecycle in one supervisor gives all
agent harnesses the same setup, health, relay, and shutdown behavior.

## What it does

- Reads the workspace's launch input and registers with `pocketcoder-server`
  over one outbound WebSocket connection.
- Runs setup, waits for explicit workload start or launches an alpha harness,
  and monitors declared services.
- Relays logs, AgentAPI traffic, attachments, terminals, and proxy streams.
- Quiesces the workspace for checkpoints and shuts child processes down in a
  controlled order.

Workspace images include the compiled `pocketcoder-supervisor` binary and use
the `supervise` command as their entrypoint. It is a private runtime package,
not a library for workspace code.

The real browser input test needs Chrome or Chromium installed. Set
`POCKETCODER_CHROMIUM_BINARY` for a custom executable. It uses a temporary profile
and a separate loopback debugging port, then removes both. The full test suite
runs this test in its own Bun process through `test:browser`.

## Waiting workload control (protocol 12)

`waitingExecSpec` renders an immutable canonical snapshot into template-owned
commands. It supplies no automatic harness. After setup, credential clearing and
controller revocation acknowledgment, the supervisor starts infrastructure and
sends `runtime_ready`. It can receive files/control traffic without a task or
agent. Agent service health does not certify runtime preparation.

The controller sends `process_start` with an exact workspace/incarnation/request
reference, acceptance fingerprint and declared operation name. The command comes
from the template, never from a control caller. The finite owner claims before
spawn, creates a separate process group, and permits one command per fresh runtime.
A retry of the same request/fingerprint returns its existing fact. Another request,
changed fingerprint or a reference from another runtime cannot spawn work.

`finite_process` reports claim, running and terminal facts. Exit code and signal
are separate observed values. Timestamps and process group ID belong to this
owner, not a human terminal session. Spawn uncertainty is `lost`. A transport
reconnect replays the same fact and never recreates a process. Terminal facts
repeat until `process_ack` follows a durable controller write. `process_lookup`
observes the same request; `process_cancel` signals only its owned process group.

Task exit keeps the supervisor and infrastructure alive. The finalization owner
must stop remaining writers before reading outputs and then release the workspace.
Workspace TERM/KILL closes the finite process group and infrastructure. Detached
children have no survival guarantee. Explicit workspace services have their own
groups and are not canceled with a finite command.

Docker binds the runtime to its observed container ID and rejects an in-place
restart as the same incarnation. Restore needs a new workspace UUID. Kubernetes
waiting-profile qualification, durable dispatch/cancel acceptance, trusted inputs
and automatic exports belong to their later gates. Canonical public publication
remains disabled until those requirements are implemented.

Model-free proof uses real Bun children and a bundled supervisor in
`oven/bun:1.4.2`. Tests cover waiting, immediate exit 0, exit 7, a long command,
signals, reconnect, stale references, durable facts and a real Docker container
crash. Test bounds are 1 MiB/input, 8 MiB staged input, 16 inputs, 2 transfers,
4 MiB/16 exports, 600s input retention, 900s export retention, a 600s deadline and
30s finalization. They are fixture settings, not production defaults. File/export
qualification is outside this process proof.
