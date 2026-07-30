# pocketcoderctl reference

`pocketcoderctl` is the operator and diagnostics CLI. Install it with
`bun add --global @pocketcoder/cli`, run it via `bun run ctl -- <args>` from the
repo root, run `bun packages/cli/src/index.ts`, use a compiled binary
(`bun run --filter '@pocketcoder/cli' compile`), or run it inside the server
container (`bun /opt/pocketcoder/ctl.js`).

Commands use one of two access paths:

- **Database commands** (migrations, principals, keys, template listing) need
  `POCKETCODER_DATABASE_URL`, `POCKETCODER_DATABASE_SCHEMA` (default
  `pocketcoder`), and for key issuance `POCKETCODER_AUTH_PEPPER`.
- **REST commands** (workspaces, doctor) need `POCKETCODER_URL` (default
  `http://127.0.0.1:7080`) and `POCKETCODER_KEY` (a machine key).

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
`workspaces:cancel`, `services:relay`, `logs:read`, `admin`. A key's effective
scopes are the intersection of its own scopes and its principal's. Keys are
displayed once and stored as keyed digests; revocation applies on the next
request.

## Templates

```sh
pocketcoderctl templates validate deploy/templates/*.json   # offline validation, prints digest
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
  [--external-id <id>] [--input '<json>']
pocketcoderctl workspaces get --id <uuid>
pocketcoderctl workspaces logs --id <uuid> [--after <seq>] [--limit <n>]
pocketcoderctl workspaces cancel --id <uuid>
```

- `--active` filters to nonterminal states (`queued`, `provisioning`,
  `connected`, `ready`, `terminating`).
- `create` uses `--external-id` as both the caller task identity and the
  idempotency key (a `ctl-<uuid>` is generated when omitted); repeating the
  same external id with the same body returns the existing workspace.
- `--input` is the opaque `launch_input` JSON delivered to the harness in
  memory as `POCKETCODER_LAUNCH_INPUT`.
- `cancel` is idempotent and never creates a replacement workspace.

## Doctor

```sh
pocketcoderctl doctor --template <name>
```

Creates a probe workspace, waits up to five minutes for `ready`, performs a
`GET /status` through the service relay, prints the result, and cancels the
probe (also on failure or timeout). Exit code 0 means the entire path — API,
store, driver, container, supervisor, harness, relay — works.
