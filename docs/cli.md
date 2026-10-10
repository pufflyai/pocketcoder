# pcd reference

`pcd` is the operator and diagnostics CLI. Install it with
`bun add --global @pstdio/pocketcoder-cli`, run it via
`bun run pcd -- <args>` from the
repo root, run `bun packages/cli/src/index.ts`, use a compiled binary
(`bun run --filter '@pstdio/pocketcoder-cli' compile`), or invoke `pcd` inside
the server container.

Principal and key commands use HTTP against the running server. Set
`POCKETCODER_URL` (default `http://127.0.0.1:8090`) and `POCKETCODER_KEY`.
Workspaces, checkpoints, storage, pools, template catalog and doctor commands
use the same settings. `templates import <directory>` publishes immutable versions
over HTTP. `superuser create` and `backup create` use the private local socket in
`POCKETCODER_DIR`.

`pcd --version` prints the installed `@pstdio/pocketcoder-cli` version, and
`pcd --help` lists the command tree. Neither needs credentials.

## Environment files

`pcd` uses project-scoped environment discovery. It finds the
nearest `.env` file, starting in the current directory and walking up through
its parents. Variables already exported by the shell take precedence over
values in the file.

Use `--workdir <directory>` to select a different project directory. This also
changes the working directory for relative command arguments. Use
`--env-file <path>` to select a specific file for variables that are not
already exported; relative paths are resolved from the work directory.

```sh
pcd --workdir ../my-project workspaces list --active
pcd --env-file .env.staging workspaces list --active
```

Keep real keys out of version control. The repository's `.env.example` can be
copied to `.env`, which is already ignored by Git.

## Server process

```sh
pcd serve --dir ./pc_data --http 127.0.0.1:8090
pcd superuser create --dir ./pc_data --json
pcd superuser create --dir ./pc_data --automation --expires <future-ISO8601> --json
```

`serve` runs in the foreground. An empty folder gets private controller keys.
Owner keys default to 24 hours and plaintext is shown once. Save a
`--request-id` to retry a lost response without issuing another key.
`--replace` revokes earlier owner keys. Only the fixed `owner` principal is
supported here. The agent listener defaults to `0.0.0.0:8091`; configure it
with `POCKETCODER_AGENT_HTTP` and point `POCKETCODER_WORKSPACE_SERVER_URL`
at that listener. Operator and agent routes are separate.


```sh
pcd backup create --dir ./pc_data --out <new-archive> [--timeout 30]
pcd backup verify <archive>
```

`backup create` writes a private archive of the running controller: its database,
keys and the checkpoint archives the database refers to, all from one point in time.
`backup verify` checks an archive without the data folder or a running server. See
[getting started](getting-started.md#back-up-the-controller).

```sh
pcd server start [--foreground] [--timeout-seconds 30]
pcd server status [--json]
pcd server stop [--timeout-seconds 15]
```

These commands manage only the PocketCoder server process. `start` reads the
normal server environment and starts the same implementation as `bun run
start`; it does not build images, generate templates, start a model gateway,
create credentials, or launch a workspace.

Background starts record an identity-protected PID and log path under
`POCKETCODER_STATE_DIR`. `stop` refuses to signal a process whose identity does
not match that record. Use `--foreground` to keep the server attached and stop
it with Ctrl-C.

## Data folder and migrations

The server loads a migrated seed and applies pending migrations on startup.
Unknown histories and checksum drift stop startup. Use `POCKETCODER_DIR` to
select the private data folder. Use local disk or a block volume, never NFS.

## Principals and machine keys

Use an explicit owner admin key, or a key with `principals:admin` and enough
scope and template grants for the target. The server hides stronger principals
and rejects self-edit. Principal IDs and names remain immutable.

```sh
pcd principals create --name example-backend \
  --scopes templates:read,workspaces:create,workspaces:read \
  --templates echo-harness --json
pcd principals list --json
pcd principals get --id <principal-id> --json
pcd principals update --id <principal-id> --scopes workspaces:read --json
pcd principals update --id <principal-id> --disabled --json
pcd principals update --id <principal-id> --disabled=false --json

pcd keys issue --principal-id <principal-id> --request-id <operation-id> \
  --scopes workspaces:read --templates echo-harness --expires <ISO8601> --json
pcd keys list --principal-id <principal-id> --request-id <operation-id>
pcd keys revoke --principal-id <principal-id> --id <key-id>
pcd keys revoke-all --principal-id <principal-id>
```

Issuance requires explicit scopes, a request ID and a future expiry within the
calling key's remaining lifetime. Requested grants must fit both caller and
target. Template grants also intersect the principal's live allowlist on every
request. Omitting `--templates` during issuance snapshots the target's current
grants. Omitting it during a principal update preserves the current grants.
Disabling a principal revokes all its keys before returning. Re-enabling it does
not revive those keys.

An explicit admin key can issue recovery keys on a dedicated recovery principal with
`--scopes keys:read,keys:write,workspaces:recover`,
`--manage-principals <target-uuid,...>`, `--templates`, `--expires` and
`--request-id`. Delegated keys only manage their exact targets. They can list
and revoke credentials for disabled targets. They cannot issue administrative
credentials or credentials for administrative targets.

Persist the request ID before issuing. The secret is returned once and is never
stored for replay. If the response is lost, list by request ID, revoke that key,
then issue with a fresh request ID. See [verifiable cleanup](cleanup.md).
Never give a workspace an operator or owner key.

Scopes include `principals:admin`, `templates:read`, workspace, checkpoint,
conversation, attachment, output, relay, log, network and terminal scopes, plus
explicit owner `admin`. See the generated OpenAPI schemas for the complete list.

## Controller secrets

```sh
pocketcoder secrets put <name> --file <protected-json-file>
pocketcoder secrets put <name> --file=-  # read JSON from stdin
pocketcoder secrets list [--json]
pocketcoder secrets retire <name>
```

These commands use HTTP and require `secrets:write` or `admin`. Input is bounded
at 64 KiB. Responses contain metadata only. Keep the input outside workspace
files and mounts. Supported types are `registry` and `setup-issuer`. See the
[private-image recipe](templates.md#private-images) and
[private-source setup](private-source.md).

## Templates

```sh
pcd templates validate examples/templates/*.json # validate manifests offline, no server needed
pcd templates render <manifest> --image <repo@sha256:digest> --out <directory> \
  [--set '<json-pointer>=<json-value>']...
pcd templates list [--json]                      # versions the key may launch, through the REST API
pcd templates import <directory>                 # publish reviewed versions over HTTP
```

`templates render` reads JSON or YAML, replaces a placeholder image with an
immutable digest, applies repeatable typed JSON-Pointer overrides, validates
the result, and writes canonical JSON as `<out>/<template-name>.json`. The
generated version is `<source-version>-<12-character-content-hash>`, so equal
inputs produce equal files and any deployable content change gets a new
identity. Override values must be JSON, including the quotes around strings:

```sh
pcd templates render templates/codex.yaml \
  --image "registry.example/codex@sha256:<64-hex-digest>" \
  --set '/spec/agent/termWidth=120' \
  --set '/spec/agent/env={"MODEL":"gpt-5"}' \
  --out deploy/templates
```

Treat overrides as non-secret build inputs: the command does not echo their
values, but the shell and build system may retain its arguments. Use reviewed
`secretRef:` values or runtime delivery for credentials.

There is deliberately no `templates create/push`: templates are reviewed
deployment files loaded from `POCKETCODER_TEMPLATE_DIR` at server startup, so a
leaked machine key can never change what code runs. See
[Templates](templates.md).

## Workspaces

```sh
pcd workspaces list [--active] [--state <state>] [--template <name>] \
  [--external-id <id>] [--limit <n>] [--json]
pcd workspaces create --template <name> [--version <v>] \
  [--external-id <id>] [--input '<json>'] [--source <alias>] [--revision <rev>] \
  [--wait] [--wait-timeout-seconds 300] [--cancel-on-exit] [--json]
pcd workspaces get --id <uuid>
pcd workspaces logs --id <uuid> [--cursor <opaque>] [--limit <n>]
pcd workspaces network-events --id <uuid> [--cursor <opaque>] [--limit <n>]
pcd workspaces terminal --id <uuid> [--session <uuid>]
pcd workspaces terminal-sessions --id <uuid> [--cursor <opaque>] [--limit <n>]
pcd workspaces cancel --id <uuid>
pcd workspaces attach --id <uuid> [--after <cursor>] [--message <text>] \
  [--file <path>]... [--json]
pcd workspaces chat --id <uuid> [--message <text>] [--follow] [--json] \
  [--poll-interval-ms 500] [--response-timeout-seconds 600] [--cancel-on-exit]
pcd workspaces preserve --id <uuid> [--retention 24h] [--label <label>]
pcd workspaces restore --checkpoint <uuid> --external-id <new-id> [--input '<json>']
pcd workspaces recreate --id <source-uuid> --external-id <new-id> [--input '<json>']
pcd workspaces outputs --id <uuid>
```

- `--active` filters to nonterminal states (`queued`, `provisioning`,
  `connected`, `ready`, `terminating`).
- `create` uses `--external-id` as both the caller task identity and the
  idempotency key (a `pcd-<uuid>` is generated when omitted); repeating the
  same external id with the same body returns the existing workspace.
- `create --wait` follows the durable workspace change cursor until `ready`;
  terminal launch failures include their bounded redacted failure log.
- `--input` is the opaque `launch_input` JSON delivered to the harness in
  memory as `POCKETCODER_LAUNCH_INPUT`. It works for create, restore, and
  recreate; each new execution receives its own bounded input, which is part
  of idempotency and is erased from the server once that execution is ready.

- `cancel` is idempotent and never creates a replacement workspace.
- `attach` stores only a message cursor in the local state directory (mode
  `0600`); it never stores a supervisor/reconnect credential.
- `attach --file` uploads each local file to the workspace attachment API
  (requires the `attachments:write` scope and `--message`) and sends their
  IDs with the turn; the agent receives the files' workspace paths. A failed
  upload aborts before any message is sent.
- `chat` uses the same allowlisted AgentAPI message routes for repeated turns.
  Ctrl-C/EOF detaches without canceling unless `--cancel-on-exit` is supplied.
- Inside `chat`, `/attach <path>` queues a local file, `/attachments` lists
  the queue, and `/detach <index|all>` removes entries. Queued files upload
  with the next non-command message; if an upload fails the message is not
  sent and the queue is kept.
- `terminal` requires a template `terminal` block and `terminal:attach`. It
  runs only the template-declared command, mirrors remote exit status, sends
  terminal resize events, and detaches without stopping the PTY on Ctrl-]
  followed by `d`. Reattach with the printed session id; recent output replays.
- `terminal-sessions` requires `terminal:read` and prints the metadata-only
  audit trail. Keystrokes and output content are never recorded.
- `preserve` ends the source execution. `restore` and `recreate` always create
  a new execution and accept a caller-chosen external ID and optional new
  launch input; they never reuse the source execution's input.

## Warm pool inventory

`pcd pools list [--json]` reports configured desired capacity, runtime state counts, oldest ready age, warm hits/misses, lease latency, and reconciliation failures. It requires an admin-scoped machine key. Pools are operator configuration; workspace callers cannot create or tune them.

## Checkpoints and storage

```sh
pcd checkpoints list --workspace <uuid> [--state ready] [--json]
pcd checkpoints get --id <uuid>
pcd checkpoints verify --id <uuid>
pcd checkpoints delete --id <uuid>

pcd storage doctor
pcd storage list-orphans
pcd storage prune
```

Storage commands require an `admin` key. `list-orphans` reports opaque
physical IDs that have no metadata but never deletes them automatically;
`prune` deletes only ready checkpoints whose recorded retention has expired.

## Doctor

```sh
pcd doctor --template <name> [--turn-timeout-seconds 60]
```

Creates a probe workspace, waits up to five minutes for `ready`, validates
`GET /status`, and requires a nonce-bearing message to produce its correlated
agent response before the turn timeout. The supervisor first proves every
declared writable memory path can create, sync, read, and remove a sentinel.
The probe is canceled on success, failure, or timeout; failures print the
workspace log tail. Exit code 0 means the entire path — API, store, driver,
container, writable mounts, supervisor, harness, and relay — works.
