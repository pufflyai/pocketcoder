# Getting started

## Standalone development download

Use Docker Engine, the authenticated [GitHub CLI](https://cli.github.com), and `jq`. The controller needs no Bun install, checkout, external database or SQL files.
CI keeps development downloads as artifacts for a passing commit. They expire under GitHub's artifact retention policy and never update stable/latest.

Copy the full 40-character commit from a passing PocketCoder PR. Run this in an empty directory. The prompt pins the download to that commit:

```sh
umask 077
mkdir pc-native && cd pc-native
printf 'Full commit from a passing PR: '
read -r PC_COMMIT
test "${#PC_COMMIT}" -eq 40 || exit 1
case "$(uname -s)" in Darwin) PC_PLATFORM=darwin ;; Linux) PC_PLATFORM=linux ;; *) exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) PC_ARCH=arm64 ;; x86_64) PC_ARCH=x64 ;; *) exit 1 ;; esac
PC_RUN=$(gh run list --repo pufflyai/pocketcoder --workflow ci.yml \
  --commit "$PC_COMMIT" --status success --json databaseId --jq '.[0].databaseId')
test -n "$PC_RUN" && test "$PC_RUN" != null || exit 1
gh run download "$PC_RUN" --repo pufflyai/pocketcoder \
  --name "pocketcoder-$PC_COMMIT-$PC_PLATFORM-$PC_ARCH" --dir .
gh run download "$PC_RUN" --repo pufflyai/pocketcoder \
  --name "pocketcoder-fixture-$PC_COMMIT-$PC_ARCH" --dir fixture
test "$(jq -r .commit native.json)" = "$PC_COMMIT" || exit 1
PC_SHA=$(if command -v sha256sum >/dev/null; then sha256sum pocketcoder; else shasum -a 256 pocketcoder; fi)
test "${PC_SHA%% *}" = "$(jq -r .sha256 native.json)" || exit 1
chmod 755 pocketcoder
docker load --input fixture/echo-image.tar
rm fixture/echo-image.tar
PC_IMAGE_TAG=$(jq -r '.spec.image | split("@")[0]' fixture/templates/echo.json)
PC_IMAGE_ID=$(docker image inspect "$PC_IMAGE_TAG" --format '{{.Id}}')
jq --arg image "$PC_IMAGE_TAG@$PC_IMAGE_ID" '.spec.image = $image' \
  fixture/templates/echo.json > fixture/echo.loaded.json
mv fixture/echo.loaded.json fixture/templates/echo.json
export POCKETCODER_STORAGE_BACKEND=filesystem
export POCKETCODER_WORKSPACE_DATA_DIR="$PWD/live"
export POCKETCODER_CHECKPOINT_DIR="$PWD/checkpoints"
./pocketcoder serve
```

The second download contains the tested, credential-free echo runtime and its digest-pinned template. Docker loads that image locally.
It uses bounded 1 MiB workspace storage and needs no registry or provider key. The operator API listens on `127.0.0.1:8090`; the separate agent listener uses port 8091.
Docker image stores can assign a different digest when loading an archive. The recipe pins the loaded image's local digest before importing its template.

In another terminal in `pc-native`, create a finite owner and run the round trip:

```sh
umask 077
./pocketcoder superuser create --json > owner.json
export POCKETCODER_URL=http://127.0.0.1:8090
export POCKETCODER_KEY=$(jq -r .token owner.json)
./pocketcoder templates import fixture/templates
PC_WORKSPACE=$(./pocketcoder workspaces create --template echo-harness --wait --json | jq -r .id)
./pocketcoder workspaces chat --id "$PC_WORKSPACE" --message 'hello from the native executable'
docker exec "pocketcoder-ws-$PC_WORKSPACE" bun -e "await Bun.write('/work/remember.txt', 'kept across restart')"
./pocketcoder workspaces preserve --id "$PC_WORKSPACE" > preserved.json
pc_wait_operation() {
  PC_STATE=running
  while test "$PC_STATE" != succeeded; do
    PC_RESULT=$(curl -fsS -H "Authorization: Bearer $POCKETCODER_KEY" \
      "$POCKETCODER_URL/v1/operations/$1") || return 1
    PC_STATE=$(printf '%s' "$PC_RESULT" | jq -r .state)
    test "$PC_STATE" != failed || return 1
    sleep 1
  done
}
pc_wait_operation "$(jq -r .operation.id preserved.json)" || exit 1
```

Stop the controller with Ctrl+C in its terminal, then run `./pocketcoder serve` there again.
Its exported storage settings, owner, keys, template and checkpoint remain. In the second terminal:

```sh
PC_CHECKPOINT=$(jq -r .checkpoint.id preserved.json)
./pocketcoder checkpoints verify --id "$PC_CHECKPOINT"
./pocketcoder workspaces restore --checkpoint "$PC_CHECKPOINT" \
  --external-id native-resume > restored.json
PC_RESUMED=$(jq -r .workspace.id restored.json)
pc_wait_operation "$(jq -r .operation.id restored.json)" || exit 1
./pocketcoder workspaces chat --id "$PC_RESUMED" --message 'hello after resume'
docker exec "pocketcoder-ws-$PC_RESUMED" cat /work/remember.txt
./pocketcoder workspaces cancel --id "$PC_RESUMED"
```

Both messages return an echo. The restored file contains `kept across restart`. Keep `owner.json` outside workspaces; the owner expires after 24 hours and its plaintext is returned once.
Stop the controller before deleting this disposable demo directory, after `workspaces get --id "$PC_RESUMED"` shows `canceled`.
Remove the echo image using the image reference in the template when finished.
For a source-based check of binary size, readiness, peak memory, restart and exact restored bytes, run `bun run example:e2e:native`.

## Prerequisites

- [Bun](https://bun.sh) 1.4.2+
- Docker (to actually run workspaces; the API works without it)

```sh
git clone <repo> && cd pocketcoder
bun install
bun run test      # database suites use memory and disk PGlite; Docker/cluster suites need those runtimes
```

## 1. Run the server

The checked-in manifests under `examples/templates` are illustrative and use
placeholder image/gateway values. Do not point a runnable server at that
directory; materialize or deploy a digest-pinned runtime template first.

Start with an empty private folder. The controller creates and keeps its keys:

```sh
bun run pcd -- serve --dir ./pc_data --http 127.0.0.1:8090
```

The operator API uses port 8090. The agent listener uses port 8091. Set
`POCKETCODER_AGENT_HTTP=0.0.0.0:<port>` to change its bind address, and
`POCKETCODER_WORKSPACE_SERVER_URL` to the agent origin reachable from workspaces.
Keep it separate from the operator port. The API contract is at
`http://127.0.0.1:8090/v1/openapi.json`.

In another terminal, create the owner key through the private local socket:

```sh
bun run pcd -- superuser create --dir ./pc_data --json
# Automation must also pass --automation --expires <future-ISO8601>.
```

The key defaults to a 24-hour expiry and is returned once. Save it outside
workspaces. A repeated `--request-id` returns metadata without the plaintext.
Set `POCKETCODER_URL=http://127.0.0.1:8090` and `POCKETCODER_KEY` to the returned
owner key, then publish a reviewed, digest-pinned template:

```sh
bun run pcd -- templates import <manifest-directory>
```

Publishing requires `templates:write` and a matching template name grant.
Versions are immutable. Publishing identical content is safe to repeat. The
SDK also supports `templates.publish(manifest)` and `templates.retire(name, version)`.

For a complete local echo demonstration, run:

```sh
bun run example:e2e:local-echo
```

It builds the local image, starts an empty controller, creates a finite owner,
publishes the template over HTTP, waits for a real Docker workspace, checks
credential isolation, sends a message, removes the container, and restarts with
the same keys and template. It prints image and template digests and cleans up
its temporary data and image. It needs Bun and a running Docker Engine.

Echo needs no runtime or registry secret. Its only workspace credentials are
registration and reconnect credentials tied to that workspace. The supported
path in this demonstration uses unrestricted networking and no persistent mount.
A runtime that needs provider authority must use credentials scoped to its
workspace that expire with it; never copy an owner, controller or registry key
into a template or workspace. The issuer/private-pull matrix and backup/recovery
remain separate development work. This command proves the local flow, not the
full 1.0 release.

For a persistent local Pi deployment, after configuring the data folder, a principal
and machine key, run the optional repository convenience:

```sh
OPENAI_API_KEY=... OPENAI_MODEL=... \
bun run local:up -- --template pi-harness --openai
```

It builds the Pi image, writes a content-versioned runtime manifest under
`.pocketcoder/local/templates`, starts a host-side OpenAI gateway, and starts
the server. Provider credentials remain in the host gateway. This is repository
deployment tooling, not a `pcd` command.

To compose the same deployment explicitly, keep the setup and gateway outside
the CLI:

```sh
# One-time/idempotent setup: docker build + image inspect + template/secret render.
OPENAI_MODEL=<model> \
bun run local:prepare -- --template pi-harness --openai

# Terminal 1: credential-bearing host gateway.
OPENAI_API_KEY=<key> OPENAI_MODEL=<model> \
bun run local:gateway -- --openai

# Terminal 2: only the already-configured PocketCoder server.
export POCKETCODER_TEMPLATE_DIR="$PWD/.pocketcoder/local/templates"
export POCKETCODER_SECRET_PROVIDER=file
export POCKETCODER_SECRET_ROOT="$PWD/.pocketcoder/local/secrets"
bun run pcd -- server start
```

`local:prepare` runs the equivalent of `docker build -f
examples/harnesses/pi/Dockerfile -t pocketcoder-pi:local .` and `docker image
inspect`, then validates and renders the digest-pinned template. It is safe to
rerun. `local:gateway` reads only the generated workspace-to-gateway bearer;
the OpenAI key remains in that host process. You can inspect or stop the server
independently with `pcd server status` and `pcd server stop`.

### Test automatic resume in an isolated terminal

PocketCoder provides filesystem storage, checkpoints, and restore. The local
resume example enables these features and supplies the terminal's resume callback:

```sh
# Set OPENAI_API_KEY and OPENAI_MODEL in .env, or export them in your shell.
bun run example:pi:resume
```

Docker must be running. The command builds the Pi image and remote client, then
starts an isolated PGlite database, API, model gateways, and temporary storage.
It does not use your existing PocketCoder server, machine key, or database.
Startup prints each build and setup stage. Ctrl+C stops waiting while the server
continues starting. Run the same command again to wait for that server. Each
session directory allows one server, so retrying cannot replace your session.

Ask Pi to write a value to `/workspace/resume-test.txt`. Type `/quit` and wait
for `Session saved`. Run the same command again. The earlier conversation appears
when Pi opens. Ask it to read the file and recall your earlier message. Its first
new message restores the saved workspace and Pi session with fresh credentials.

The isolated server keeps running in the background after Pi exits. Its connection
file is under `.pocketcoder/resume-session`, readable only by your host user. Run
the command from the same directory to reconnect. Pi's local `/resume` picker is
not used here; PocketCoder stores the conversation and checkpoint on the server.
You can also wait 60 seconds or type `/preserve` to test automatic resume without
closing the terminal.

The host gateway holds the provider key. Each workspace gets a separate bearer
that the gateway rejects as soon as that execution stops. This test session lasts
two hours from its first launch, including time spent disconnected. At that point
it removes the test database and checkpoints. The host operator key has five more
minutes for cleanup. This example survives closing Pi; it does not survive a host
reboot or a Docker reset.

```sh
# Reconnect after /quit.
bun run example:pi:resume

# Delete the isolated session, database, and checkpoints when finished.
bun run example:pi:resume -- --stop

# Choose the idle interval when starting a new session.
bun run example:pi:resume -- --idle-seconds 120

# Run real Pi and AgentAPI with a deterministic model, without a provider key.
# Checks idle resume, /quit, a second launcher, history, files, and model context.
bun run example:pi:resume:check
```

The build and server log is `.pocketcoder/resume-session/daemon.log`. Use
`--state-dir <directory>` for a separate isolated session, and pass that same
directory when reconnecting or stopping it.

## 2. Create a principal and machine key

The isolated examples above bootstrap their own bounded owner credentials. For
an existing running server, use its bounded owner key in `POCKETCODER_KEY` and
set `POCKETCODER_URL`. Principal and key commands use HTTP. Use the ID returned
by create for later administration:

```sh
bun run pcd principals create --name my-backend \
  --scopes templates:read,workspaces:create,workspaces:read,workspaces:cancel,workspaces:preserve,workspaces:restore,checkpoints:read,checkpoints:delete,outputs:read,conversations:read,conversations:delete,services:relay,attachments:write,logs:read,network:read,terminal:attach,terminal:read \
  --templates '*' --json
bun run pcd keys issue --principal-id <returned-id> --request-id <operation-id> \
  --scopes templates:read,workspaces:create,workspaces:read,workspaces:cancel,workspaces:preserve,workspaces:restore,checkpoints:read,checkpoints:delete,outputs:read,conversations:read,conversations:delete,services:relay,attachments:write,logs:read,network:read,terminal:attach,terminal:read \
  --templates '*' --expires <ISO8601-within-owner-expiry> --json
```

Choose scopes for the workload and an expiry within the owner's remaining
lifetime. The key is returned once; the database keeps only its keyed digest.
Scope and template grants intersect the principal's current grants. Revoke with
`keys revoke --principal-id <principal-id> --id <key-id>`; it takes effect on the
next request. Keep owner and backend keys outside every workspace.

## 3. Launch a workspace

Add the issued key to `.env` in the project root:

```dotenv
POCKETCODER_URL=http://127.0.0.1:8090
POCKETCODER_KEY=pkt_…
```

The CLI loads it automatically, so no shell export is required:

```sh
pcd templates list                       # what you may launch
pcd workspaces create --template <name> --wait  # waits through ready or failure
pcd workspaces list --active             # queued/provisioning/connected/ready/terminating
pcd workspaces logs --id <uuid>          # bounded operational logs
pcd workspaces terminal --id <uuid>      # template-declared interactive PTY
```

A workspace goes `queued → provisioning → connected → ready`. Once `ready`,
converse interactively through the template's allowlisted AgentAPI relay:

```sh
pcd workspaces chat --id <uuid>
```

For direct API integration, the same relay routes are available:

```sh
curl -s -X POST "$POCKETCODER_URL/v1/workspaces/<uuid>/agent/message" \
  -H "Authorization: Bearer $POCKETCODER_KEY" -H "content-type: application/json" \
  -d '{"content":"fix the failing test","type":"user"}'
curl -s "$POCKETCODER_URL/v1/workspaces/<uuid>/agent/messages" \
  -H "Authorization: Bearer $POCKETCODER_KEY"
```

Finish with `pcd workspaces cancel --id <uuid>`; the supervisor
TERMs the process tree, the container is removed, and the workspace ends in a
terminal state that never reopens.

For a persistence-enabled template, keep the execution or recreate it later:

```sh
pcd workspaces attach --id <uuid> --message "continue the task"
pcd workspaces preserve --id <uuid> --label laptop-handoff
pcd checkpoints list --workspace <uuid>
pcd workspaces restore --checkpoint <checkpoint-uuid> \
  --external-id resumed-task
```

Preserve ends the original execution as `preserved`; restore creates a new
execution with fresh credentials and an independent writable copy. Configure
`POCKETCODER_STORAGE_BACKEND` before using a template with persistent mounts.

## 4. Verify the full path

`doctor` creates a probe workspace from a template, waits for readiness, then
sends a nonce and requires a correlated agent response through the relay
before canceling it:

```sh
pcd doctor --template <name> --turn-timeout-seconds 60
```

If this prints `doctor: ok`, the server, database, driver, supervisor, and
relay all work. The supervisor also creates, writes, syncs, reads, and removes
a sentinel in every declared `writableMemoryPath` as the workspace uid before
running setup. A status-only `cat` harness cannot make doctor pass.

## Next steps

- Write your own environment: [Templates](templates.md)
- Wire up your backend, including a stateless turn after preservation:
  [`@pstdio/pocketcoder-sdk`](../packages/sdk/README.md) or the [HTTP API](api.md)
- Use a local coding-agent UI against a workspace:
  [`@pstdio/pocketcoder-remote`](../packages/remote/README.md)
- Run it for real: [Deployment](deployment.md)
