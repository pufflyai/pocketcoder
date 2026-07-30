# pocketcoderctl reference

`pocketcoderctl` is the operator and diagnostics CLI. Install it with
`bun add --global @pstdio/pocketcoder-cli`, run it via
`bun run ctl -- <args>` from the
repo root, run `bun packages/cli/src/index.ts`, use a compiled binary
(`bun run --filter '@pstdio/pocketcoder-cli' compile`), or run it inside the server
container (`bun /opt/pocketcoder/ctl.js`).

Commands use one of two access paths:

- **Database commands** (migrations, principals, keys, template listing) need
  `POCKETCODER_DATABASE_URL`, `POCKETCODER_DATABASE_SCHEMA` (default
  `pocketcoder`), and for key issuance `POCKETCODER_AUTH_PEPPER`.
- **REST commands** (workspaces, doctor) need `POCKETCODER_URL` (default
  `http://127.0.0.1:7080`) and `POCKETCODER_KEY` (a machine key).

## Environment files

`pocketcoderctl` uses project-scoped environment discovery. It finds the
nearest `.env` file, starting in the current directory and walking up through
its parents. Variables already exported by the shell take precedence over
values in the file.

Use `--workdir <directory>` to select a different project directory. This also
changes the working directory for relative command arguments. Use
`--env-file <path>` to select a specific file for variables that are not
already exported; relative paths are resolved from the work directory.

```sh
pocketcoderctl --workdir ../my-project workspaces list --active
pocketcoderctl --env-file .env.staging workspaces list --active
```

Keep real keys out of version control. The repository's `.env.example` can be
copied to `.env`, which is already ignored by Git.

## Database and migrations

```sh
pocketcoderctl db migrate     # apply pending migrations (schema-scoped advisory lock)
pocketcoderctl db status      # per-migration applied/pending/DRIFTED
```

## Principals and machine keys

```sh
pocketcoderctl principals create --name example-backend \
  --scopes templates:read,workspaces:create,workspaces:read,workspaces:cancel,services:relay,logs:read \
  --templates echo-harness,pi-harness    # or '*' for all templates
pocketcoderctl principals list

pocketcoderctl keys issue --principal example-backend [--scopes a,b] [--expires never|<ISO8601>]
pocketcoderctl keys revoke --id <key-id>
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
pocketcoderctl templates validate examples/templates/*.json # validate checked-in examples offline
pocketcoderctl templates list                               # versions + status from the database
```

There is deliberately no `templates create/push`: templates are reviewed
deployment files loaded from `POCKETCODER_TEMPLATE_DIR` at server startup, so a
leaked machine key can never change what code runs. See
[Templates](templates.md).

## Workspaces

```sh
pocketcoderctl workspaces list [--active] [--state <state>] [--template <name>] \
  [--external-id <id>] [--limit <n>] [--json]
pocketcoderctl workspaces create --template <name> [--version <v>] \
  [--external-id <id>] [--input '<json>'] [--source <alias>] [--revision <rev>]
pocketcoderctl workspaces get --id <uuid>
pocketcoderctl workspaces logs --id <uuid> [--after <seq>] [--limit <n>]
pocketcoderctl workspaces cancel --id <uuid>
pocketcoderctl workspaces attach --id <uuid> [--after <cursor>] [--message <text>] [--json]
pocketcoderctl workspaces preserve --id <uuid> [--retention 24h] [--label <label>]
pocketcoderctl workspaces restore --checkpoint <uuid> --external-id <new-id>
pocketcoderctl workspaces recreate --id <source-uuid> --external-id <new-id>
pocketcoderctl workspaces outputs --id <uuid>
```

- `--active` filters to nonterminal states (`queued`, `provisioning`,
  `connected`, `ready`, `terminating`).
- `create` uses `--external-id` as both the caller task identity and the
  idempotency key (a `ctl-<uuid>` is generated when omitted); repeating the
  same external id with the same body returns the existing workspace.
- `--input` is the opaque `launch_input` JSON delivered to the harness in
  memory as `POCKETCODER_LAUNCH_INPUT`.
- `cancel` is idempotent and never creates a replacement workspace.
- `attach` stores only a message cursor in the local state directory (mode
  `0600`); it never stores a supervisor/reconnect credential.
- `preserve` ends the source execution. `restore` and `recreate` always create
  a new execution and accept a caller-chosen external ID.

## Checkpoints and storage

```sh
pocketcoderctl checkpoints list --workspace <uuid> [--state ready] [--json]
pocketcoderctl checkpoints get --id <uuid>
pocketcoderctl checkpoints verify --id <uuid>
pocketcoderctl checkpoints delete --id <uuid>

pocketcoderctl storage doctor
pocketcoderctl storage list-orphans
pocketcoderctl storage prune
```

Storage commands require an `admin` key. `list-orphans` reports opaque
physical IDs that have no metadata but never deletes them automatically;
`prune` deletes only ready checkpoints whose recorded retention has expired.

## Doctor

```sh
pocketcoderctl doctor --template <name>
```

Creates a probe workspace, waits up to five minutes for `ready`, performs a
`GET /status` through the service relay, prints the result, and cancels the
probe (also on failure or timeout). Exit code 0 means the entire path — API,
store, driver, container, supervisor, harness, relay — works.
