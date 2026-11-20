# Remote test runner

Run a repository command in an isolated workspace. The private
[Remote Testing companion](../../../.pstdio/extensions/remote-testing) uploads source,
starts runs, collects evidence and keeps qualification records. Prompt Studio owns
commands, test selection and result interpretation.

## Source and evidence

The `pocketcoder.remote-test/v2` request contains two Git bundles: all history through a
pinned `origin/main`, and a thin candidate bundle. When the base already contains the
candidate, no second bundle is needed. The runner verifies base, HEAD and tree, checks
out detached, and retains no remote URL. Dirty sources apply an uncommitted overlay,
including deletions. They stay dirty; they cannot become a clean review by upload.

Object GET URLs expire after 30 minutes and are signed only when the workspace is ready.
Log and result PUT URLs expire after the run timeout plus 30 minutes, bounded by the workspace deadline. They grant access
to one object each. The workspace receives no Git or reusable storage credential.

Before a command, preflight checks the workspace deadline, required Git history, Docker,
Bun and Node pins, and pinned Chromium when browsers are required. Node pins come from
the candidate's CI workflow. Playwright pins come from its root or e2e package. A mismatch
reports `prerequisite_missing` and runs no tests. `TMPDIR` is `/workspace/tmp` on disk.

A workspace lock owns the checkout and daemon through teardown. Only an explicitly kept
workspace releases its lock after collection; a rejected concurrent request cannot stop
the owner. Host claims use atomic creation and updates as an early guard.

A run uploads the complete log and an archive of `test-results/`, even after failure,
cancellation or timeout. Missing evidence prevents a `passed` result. The final Pi
message contains one `REMOTE_TEST_RESULT` line with source identity, target host, runtime
pins, preflight checks, exit status, timing and upload outcomes. Signed URLs never enter
the saved ledger. The companion retains local logs and archives after workspace deletion.

## Images and templates

```sh
docker build -f examples/harnesses/test-runner/Dockerfile -t pocketcoder-test-runner .
bun examples/harnesses/test-runner/render-template.ts <image@sha256:…> <out-dir>

docker build -f examples/harnesses/test-runner/review.Dockerfile -t prompt-studio-review .
bun examples/harnesses/test-runner/render-template.ts <image@sha256:…> <out-dir> review
```

Publish the rendered, digest-pinned manifest. `remote-tests` is the unprivileged runner.
`prompt-studio-review` needs the operator's `container-engine` placement grant. Its image
contains Playwright 1.60.0, Bun 1.4.4, Node 24.22.1, Docker 28.5.2, Compose and Xvfb. It
requests 8 CPU, 16 GiB memory and a 60 GiB workspace. These are starting sizes, not measured
review performance. Both templates live for two hours and become idle after 30 minutes.
The run timeout remains 60 minutes. A run reserves three minutes for evidence collection.
The runner adapter allows that finalization grace on cancellation; ordinary Pi cancellation
keeps its five-second limit. Archive and concurrent uploads share a 165-second budget,
leaving time to report the outcome.

The engine image starts its own `dockerd` in the workspace container, inside its Kata VM,
then drops the supervisor to UID/GID 10001. The daemon uses `/workspace/docker` and a
workspace-local Unix socket. It sees the same absolute paths as the tests. There is no
host socket, TCP daemon listener, shared daemon, host network or device passthrough.
The Docker store uses a 32 GiB sparse ext4 disk at `/workspace/docker.ext4`, mounted
inside the VM. Kata's shared filesystem cannot directly back Docker's overlay2 driver.
The disk consumes workspace storage, not a memory-backed volume. Buildx and Compose
come from the same pinned Docker image as the daemon.
Before starting Docker, the entrypoint moves itself into an init cgroup and
enables the guest's cgroup v2 controllers. Nested memory and PID limits are
checked by the live regression test.
The VM and its nested containers, volumes and networks disappear with the pod.

On a real engine workspace, run the adjacent regression test as UID 10001:

```sh
bun test --timeout 120000 /opt/pocketcoder/engine.conformance.test.ts
```

Run it in two workspaces at once with different `ROLE` values. Both create the same
container, network and volume names; each must retain its own contents. Delete one
workspace and verify the other daemon and its resources still work.

## Partial qualification

Configure one approved template per available target in the companion. Publish a second
review manifest with an arm64 engine profile and its own name for linux-arm64. The image
must support that host. Each host builds its own plan with
`bun scripts/test.ts --stage full`; plans never cross hosts.

macOS and Windows workers are tracked in PC-197. Until those exist, qualification lists
those targets as `no_worker`, with `coverage: partial` and `status: incomplete`. Linux
success is not full qualification. Live Kata isolation, cancellation, restart recovery,
Chromium, both Linux full plans and review duration require proof on the target cluster.
