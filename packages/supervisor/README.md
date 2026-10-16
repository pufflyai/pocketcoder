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

Task exit keeps the supervisor and infrastructure alive. Before reporting a terminal
fact, the supervisor stops remaining group writers with TERM and then KILL within
the canonical template’s `limits.finalizationSeconds` bound. It preserves the
leader’s exact exit code and signal. On Linux, a zombie leader can still have live
worker threads. The stop proof checks those threads and retries process or thread
inventory changes. A process with only dead zombie tasks does not hold the barrier
open. Output collection and workspace release remain separate.
Workspace TERM/KILL closes the finite process group and infrastructure. Detached
children have no survival guarantee. Explicit workspace services have their own
groups and are not canceled with a finite command.

Docker binds the runtime to its observed container ID and start time. An in-place
restart changes that execution-lifetime token and ends the old incarnation.
Restore needs a new workspace UUID. Kubernetes waiting-profile qualification and
automatic exports belong to their later gates. Canonical public publication remains
disabled until those requirements are implemented.

Model-free proof uses real Bun children and a bundled supervisor in
`oven/bun:1.4.2`. Tests cover waiting, immediate exit 0, exit 7, a long command,
signals, reconnect, stale references, durable facts and a real Docker container
crash. Test bounds are 1 MiB/input, 8 MiB staged input, 16 inputs, 2 transfers,
4 MiB/16 exports, 600s input retention, 900s export retention, a 600s deadline and
30s finalization. They are fixture settings, not production defaults. File/export
qualification is outside this process proof.


Protocol 13 adds explicit producer absence and stable operation cancellation
receipts. Cancellation keeps the same ID through TERM and KILL escalation.
The controller records acceptance and dispatch intent before `process_start`.
Unclaimed process facts cannot create controller execution records. See
[the execution API](../../docs/api.md#durable-execution-boundary) for public
runtime discovery, start, observation, and cancellation.

The cancellation deadline survives leader exit, reconnect and a lost acknowledgment.
Only a stopped group can publish its terminal receipt. Undispatched cancellation
releases input pins immediately. Execution finalization releases pins after the
terminal acknowledgment. Workspace purge releases remaining pins only after
provider termination is verified; a failed stop keeps them pinned.

Ordinary-exit cleanup and accepted cancellation share one escalation timer. A
delayed cancel shortens that timer when its remaining budget is earlier. Repeated
delivery cannot extend either deadline, including after the leader exits.

The cancel frame carries the original UTC deadline. Delayed delivery cannot start
a fresh grace period. This requires aligned controller and runtime clocks; the
qualified Docker fixture shares its host clock. Other providers must qualify that
clock assumption along with their runtime profile.
