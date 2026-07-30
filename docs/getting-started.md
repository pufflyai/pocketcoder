# Getting started

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- Docker (to actually run workspaces; the API works without it)
- PostgreSQL (optional for development; required for production)

```sh
git clone <repo> && cd pocketcoder
bun install
bun test          # everything runs against the in-memory store, no services needed
```

## 1. Run the server

Fastest path, no database (state dies with the process):

```sh
POCKETCODER_STORE=memory \
POCKETCODER_TEMPLATE_DIR=examples/templates \
bun run start
```

This loads illustrative manifests with placeholder images from `examples/`;
operators should point deployments at their own reviewed template directory.

With PostgreSQL (durable; the schema defaults to `pocketcoder` and may live in
a dedicated database or an existing one):

```sh
docker compose -f deploy/compose/docker-compose.yaml up -d   # local postgres on :5433
export POCKETCODER_DATABASE_URL=postgres://pocketcoder:pocketcoder@127.0.0.1:5433/pocketcoder
export POCKETCODER_AUTH_PEPPER=$(openssl rand -base64 32)

bun run ctl db migrate
POCKETCODER_TEMPLATE_DIR=examples/templates bun run start
```

The server logs which templates it loaded and refuses to start if any template
file is invalid. The OpenAPI document is at `http://127.0.0.1:7080/v1/openapi.json`.

## 2. Create a principal and machine key

There are no human accounts. Callers are **principals** (e.g. your backend)
holding **machine keys** with explicit scopes and a template allowlist:

```sh
bun run ctl principals create --name my-backend \
  --scopes templates:read,workspaces:create,workspaces:read,workspaces:cancel,workspaces:preserve,workspaces:restore,checkpoints:read,checkpoints:delete,outputs:read,services:relay,logs:read \
  --templates '*'
bun run ctl keys issue --principal my-backend --expires never
```

The key (`pkt_…`) is printed once. Store it; the database keeps only a keyed
digest. Revoke anytime with `keys revoke --id <key-id>` (takes effect on the
next request).

## 3. Launch a workspace

Add the issued key to `.env` in the project root:

```dotenv
POCKETCODER_URL=http://127.0.0.1:7080
POCKETCODER_KEY=pkt_…
```

The CLI loads it automatically, so no shell export is required:

```sh
pocketcoderctl templates list                       # what you may launch
pocketcoderctl workspaces create --template <name>  # returns the workspace JSON
pocketcoderctl workspaces list --active             # queued/provisioning/connected/ready/terminating
pocketcoderctl workspaces logs --id <uuid>          # bounded operational logs
```

A workspace goes `queued → provisioning → connected → ready`. Once `ready`,
converse with the agent through the relay (only the routes the template
declares exist):

```sh
curl -s -X POST "$POCKETCODER_URL/v1/workspaces/<uuid>/services/agent/message" \
  -H "Authorization: Bearer $POCKETCODER_KEY" -H "content-type: application/json" \
  -d '{"content":"fix the failing test","type":"user"}'
curl -s "$POCKETCODER_URL/v1/workspaces/<uuid>/services/agent/messages" \
  -H "Authorization: Bearer $POCKETCODER_KEY"
```

Finish with `pocketcoderctl workspaces cancel --id <uuid>`; the supervisor
TERMs the process tree, the container is removed, and the workspace ends in a
terminal state that never reopens.

For a persistence-enabled template, keep the execution or recreate it later:

```sh
pocketcoderctl workspaces attach --id <uuid> --message "continue the task"
pocketcoderctl workspaces preserve --id <uuid> --label laptop-handoff
pocketcoderctl checkpoints list --workspace <uuid>
pocketcoderctl workspaces restore --checkpoint <checkpoint-uuid> \
  --external-id resumed-task
```

Preserve ends the original execution as `preserved`; restore creates a new
execution with fresh credentials and an independent writable copy. Configure
`POCKETCODER_STORAGE_BACKEND` before using a template with persistent mounts.

## 4. Verify the full path

`doctor` creates a probe workspace from a template, waits for readiness,
probes the agent service through the relay, and cancels it:

```sh
pocketcoderctl doctor --template <name>
```

If this prints `doctor: ok`, the server, database, driver, supervisor, and
relay all work.

## Next steps

- Write your own environment: [Templates](templates.md)
- Wire up your backend: [HTTP API](api.md)
- Run it for real: [Deployment](deployment.md)
