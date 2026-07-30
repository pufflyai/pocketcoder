# pcd reference

`pcd` is the operator and diagnostics CLI. Install it with
`bun add --global @pstdio/pocketcoder-cli`, run it via
`bun run pcd -- <args>` from the
repo root, run `bun packages/cli/src/index.ts`, use a compiled binary
(`bun run --filter '@pstdio/pocketcoder-cli' compile`), or invoke `pcd` inside
the server container.

Commands use one of two access paths:

- **Database commands** (migrations, principals, keys, template listing) need
  `POCKETCODER_DATABASE_URL`, `POCKETCODER_DATABASE_SCHEMA` (default
  `pocketcoder`), and for key issuance `POCKETCODER_AUTH_PEPPER`.
- **REST commands** (workspaces, doctor) need `POCKETCODER_URL` (default
  `http://127.0.0.1:7080`) and `POCKETCODER_KEY` (a machine key).

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
pcd server start [--foreground] [--timeout-seconds 30]
pcd server status [--json]
pcd server stop [--timeout-seconds 15]
```

These commands manage only the PocketCoder server process. `start` reads the
normal server environment and starts the same implementation as `bun run
start`; it does not build images, generate templates, start a model gateway,
migrate a database, create credentials, or launch a workspace.

Background starts record an identity-protected PID and log path under
`POCKETCODER_STATE_DIR`. `stop` refuses to signal a process whose identity does
not match that record. Use `--foreground` to keep the server attached and stop
it with Ctrl-C.

## Database and migrations

```sh
pcd db migrate     # apply pending migrations (schema-scoped advisory lock)
pcd db status      # per-migration applied/pending/DRIFTED
```

## Principals and machine keys

```sh
pcd principals create --name example-backend \
  --scopes templates:read,workspaces:create,workspaces:read,workspaces:cancel,services:relay,logs:read \
  --templates echo-harness,pi-harness    # or '*' for all templates
pcd principals list

pcd keys issue --principal example-backend [--scopes a,b] [--expires never|<ISO8601>]
pcd keys revoke --id <key-id>
```

Scopes: `templates:read`, `workspaces:create`, `workspaces:read`,
`workspaces:cancel`, `workspaces:preserve`, `workspaces:restore`,
`checkpoints:read`, `checkpoints:delete`, `outputs:read`, `services:relay`,
`logs:read`, `admin`. A key's effective
scopes are the intersection of its own scopes and its principal's. Keys are
displayed once and stored as keyed digests; revocation applies on the next
request.

## Templates

```sh
pcd templates validate examples/templates/*.json # validate checked-in examples offline
pcd templates list                               # versions + status from the database
```

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
pcd workspaces logs --id <uuid> [--after <seq>] [--limit <n>]
pcd workspaces cancel --id <uuid>
pcd workspaces attach --id <uuid> [--after <cursor>] [--message <text>] [--json]
pcd workspaces chat --id <uuid> [--message <text>] [--follow] [--json] \
  [--poll-interval-ms 500] [--response-timeout-seconds 600] [--cancel-on-exit]
pcd workspaces preserve --id <uuid> [--retention 24h] [--label <label>]
pcd workspaces restore --checkpoint <uuid> --external-id <new-id>
pcd workspaces recreate --id <source-uuid> --external-id <new-id>
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
  memory as `POCKETCODER_LAUNCH_INPUT`.
- `cancel` is idempotent and never creates a replacement workspace.
- `attach` stores only a message cursor in the local state directory (mode
  `0600`); it never stores a supervisor/reconnect credential.
- `chat` uses the same allowlisted AgentAPI message routes for repeated turns.
  Ctrl-C/EOF detaches without canceling unless `--cancel-on-exit` is supplied.
- `preserve` ends the source execution. `restore` and `recreate` always create
  a new execution and accept a caller-chosen external ID.

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
