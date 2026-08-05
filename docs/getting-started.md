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
POCKETCODER_STORE=memory bun run pcd -- server start --foreground
```

The checked-in manifests under `examples/templates` are illustrative and use
placeholder image/gateway values. Do not point a runnable server at that
directory; materialize or deploy a digest-pinned runtime template first.

With PostgreSQL (durable; the schema defaults to `pocketcoder` and may live in
a dedicated database or an existing one):

```sh
docker compose -f deploy/compose/docker-compose.yaml up -d   # local postgres on :5433
export POCKETCODER_DATABASE_URL=postgres://pocketcoder:pocketcoder@127.0.0.1:5433/pocketcoder
export POCKETCODER_AUTH_PEPPER=$(openssl rand -base64 32)

bun run pcd db migrate
bun run pcd -- server start
bun run pcd -- server status
```

The server command starts only PocketCoder. It does not migrate the database,
build an agent image, generate a template, or start a model gateway. The server
logs which templates it loaded and refuses to start if any template file is
invalid. The OpenAPI document is at
`http://127.0.0.1:7080/v1/openapi.json`.

For a persistent local Pi deployment, after configuring PostgreSQL, a principal
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

## 2. Create a principal and machine key

There are no human accounts. Callers are **principals** (e.g. your backend)
holding **machine keys** with explicit scopes and a template allowlist:

```sh
bun run pcd principals create --name my-backend \
  --scopes templates:read,workspaces:create,workspaces:read,workspaces:cancel,workspaces:preserve,workspaces:restore,checkpoints:read,checkpoints:delete,outputs:read,services:relay,attachments:write,logs:read,terminal:attach,terminal:read \
  --templates '*'
bun run pcd keys issue --principal my-backend --expires 2027-01-01T00:00:00Z
```

Give keys a bounded expiry and rotate them; `--expires never` exists for
deliberate operational choices, not defaults ([security model](security.md)).
The key (`pkt_…`) is printed once. Store it; the database keeps only a keyed
digest. Because it was issued without `--scopes`, it follows later scope changes
made with `principals update`. Pass `keys issue --scopes ...` only when one key
must be narrower than its principal. Revoke anytime with `keys revoke --id
<key-id>` (takes effect on the next request).

## 3. Launch a workspace

Add the issued key to `.env` in the project root:

```dotenv
POCKETCODER_URL=http://127.0.0.1:7080
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
- Wire up your backend: [HTTP API](api.md)
- Run it for real: [Deployment](deployment.md)
