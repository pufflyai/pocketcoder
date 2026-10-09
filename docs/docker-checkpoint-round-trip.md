# Docker checkpoint round trip

This development check preserves one Docker workspace and restores its files into
a different workspace. It uses the real CLI, operator API, agent HTTP listener,
controller database and supervisor. It does not complete PC-61 or establish
production recovery support.

## Run the check

Use Bun 1.4.2 and a running Docker Engine. From the repository root:

```sh
bun install --frozen-lockfile
bun run example:e2e:docker-checkpoint
```

The command builds a local supervisor image and uses a private temporary controller
directory. It issues a finite owner credential, publishes the echo template over
HTTP and starts a source workspace. The owner credential stays in the host process;
it is never mounted or passed to a workspace.

The fixture declares one persistence mount and edits a small tree with known
binary content. It preserves the source, restores the checkpoint into a different
workspace ID, checks the restored tree during setup, compares the exact bytes
and requests an echo response. A second source contains a FIFO, a special file
that capture must reject. Its regular file remains exact before explicit source
cancellation. The check then verifies failed metadata and runtime cleanup.
The mount limits bound this fixture; they do not change the public template limits.

## Transfer and readiness

Docker live persistence uses disposable, size-bounded memory mounts. A checkpoint
is a controller-owned archive, not a host directory shared with the workspace.

The supervisor stops writers before capture. It declares the measured archive
size. The controller reserves physical capacity and sends a one-use upload grant
on the authenticated control connection. Archive bytes travel over HTTP. The
controller verifies the complete archive, hashes the written file, flushes and
publishes it, and commits its availability before source teardown. Reservations
cover the measured archive and temporary index files, including filesystem block
rounding. The retained charge uses the archive's native allocated blocks; the
transfer size records its exact wire bytes.

Restore uses the new destination's operation, connection epoch and download grant.
The archive header still identifies the original source. The supervisor verifies
and extracts the archive into private staging, proves the installed content and
publishes the mount contents before setup or harness startup. The controller
requires the matching installation receipt before readiness.

The server selects an explicit restore mode. Provider-installed storage can run
setup and the harness after the provider restores it. Controller archives require
the fresh transfer grant and verified installation. A missing grant does not
select the provider-installed mode. Running and readiness frames follow actual
harness spawn; spawn failure completes the failed restore lifecycle.

Matching verified installation also marks the destination's owned storage ready
in the same database transaction. It can then be edited and preserved again.
If the control connection ends during download or setup before readiness, the
restore fails and cleans up its runtime, grants and disposable storage. It does
not replay installation over files that setup may have changed. A later restore
uses the original durable checkpoint and a new workspace.

Readiness and restore-operation success commit together with their state event.
Checkpoint retention and workspace authority must remain valid through this
commit. If retention expires during setup, the restore fails and cleans up its
runtime and grants. Later health frames cannot turn that failed restore ready.

Transfer tokens stay in memory and HTTP authorization headers. They are absent
from URLs, logs, provider input files and stored plaintext. Wrong identity,
operation, epoch, expired authority or an interrupted transfer cannot complete an
operation. Normal cleanup drains owned temporary data, settles reservations and
revokes runtime authority. Cleanup does not remove an object whose native identity
has changed.

An unsuccessful preserve does not destroy unpublished source files. Transfer
scratch and credentials are cleaned up, while the bounded Docker mount remains
for a fixed 60-second recovery window. The workspace stays preserving. An operator
can recover its files from the live container during this window. Explicit API
cancellation or the recovery expiry then runs ordinary destructive cleanup.

Deadline policy preservation has a separate finite window. Only the server's
admitted deadline-policy operation can use it after workload expiry. It starts
at operation creation, uses the configured transfer budget and is capped at
60 seconds. Retries cannot renew it. Ordinary expired workspaces remain unable
to receive grants; native timestamp and exact reservation-expiry checks remain.

Prove capture refusal, measured admission refusal and a real interrupted TCP
upload with exact surviving source bytes, then explicit cancellation:

```sh
bun run example:e2e:docker-checkpoint-failures
```

Prove that a restored workspace can be edited, preserved and restored again,
then preserved by deadline policy and restored once more:

```sh
bun run example:e2e:docker-checkpoint-repeat
```

This separate fixture sets its local template's maximum age to 30 seconds to
trigger the real deadline policy. It checks the edited binary bytes and a harness
response after each restore, then verifies all source containers and temporary
storage are gone and the three retained archives have exact settled charges.

## Support boundary

This check covers one principal, one ordinary mount, a small regular-file and
directory tree and the available local architecture. PC-88 owns broader publication
crash recovery, concurrent purge, full writer accounting and fault stress. PC-89
owns cross-node Kubernetes transfer. PC-61 retains multiple mounts, the full file
corpus, platform limits and final removal of legacy shared storage.

After cancellation and controller shutdown, the check reopens the database to
verify revoked runtime credentials, deleted disposable storage, a single retained
archive and no outstanding temporary reservation. It rejects shutdown query errors.

The script removes its own workspaces, controller, image and temporary directory.
It leaves unrelated Docker resources alone. A failing check prints controller
output and exits with an error. Keep that output as evidence; helper tests alone
are not acceptance for this flow.
