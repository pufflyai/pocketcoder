# pocketcoder

A lightweight control plane for coding agents in isolated workspaces.

The development `pocketcoder` executable embeds PGlite, its seed and migrations.
It needs no Bun install or source checkout. With Docker running, `pocketcoder
serve` starts at `127.0.0.1:8090` and keeps private state in `./pc_data`.
Follow the [commit-pinned download and workspace round trip](docs/getting-started.md#standalone-development-download).
See [candidate installation](docs/candidate-installation.md) for all three targets and Node package consumers.
CI measures startup, peak memory and executable size. Development builds are
Actions artifacts named by full commit; they do not publish stable releases or
change `latest`.

- a **template** is a reviewed, versioned definition of a coding-agent
  environment;
- a **workspace** is one isolated instance of a template and the lifecycle
  record for a single coding-agent session.

**Documentation lives in [docs/](docs/README.md)** — start with [getting
started](docs/getting-started.md), then the [CLI reference](docs/cli.md),
[Node SDK](packages/sdk/README.md), [templates](docs/templates.md), [HTTP API](docs/api.md),
[deployment](docs/deployment.md), and [architecture](docs/architecture.md).

For development, read the [contributor guidance](AGENTS.md) and [CI guide](docs/ci.md).

## AgentAPI-native workspaces

Templates declare the coding agent; PocketCoder owns AgentAPI startup,
readiness, relay routes, durable transcript capture, and checkpoint shutdown:

```jsonc
// examples/templates/claude-code-agent.json (excerpt)
"spec": {
  "image": "example.registry/coding-agent@sha256:…",   // digest-pinned
  "setup": [                                            // custom setup commands,
    { "name": "clone-workspace-repo", "command": ["/usr/local/bin/clone-repo.sh"] },
    { "name": "install-deps", "command": ["bun", "install", "--frozen-lockfile"] }
  ],
  "agent": {                                            // coding agent only
    "type": "claude",
    "command": ["claude", "--dangerously-skip-permissions"],
    "cwd": "/home/agent/workspace"
  },
  "terminal": {                                         // optional, fixed command only
    "command": ["/bin/sh"],
    "cwd": "/home/agent/workspace"
  }
}
```

`setup` steps run sequentially before PocketCoder launches its pinned
`/usr/local/bin/agentapi` around `agent.command`. The fixed, bounded
conversation API is `/v1/workspaces/{id}/agent/{status|messages|message}`, plus
a streamed `events` route on snapshots created under workspace protocol v5.
Legacy `harness` and `services` templates remain readable for one migration
release, but cannot be mixed with `agent`.

## Quick start (development)

```sh
bun install
bun run test                   # full suite, using memory and disk PGlite

```

The manifests in `examples/templates` intentionally contain placeholder image
and gateway values. Validate them offline, but do not use that directory as a
runnable server catalog.

Set a private data folder on local disk or a block volume.
The fixed `pocketcoder` schema migrates automatically. With PGlite the controller
creates and keeps its own key bundle. Set `POCKETCODER_AUTH_PEPPER` only with
PostgreSQL, and keep it in private operator configuration for later restarts.

Start the server first: principal and key commands use HTTP.

```sh
POCKETCODER_TEMPLATE_DIR=/absolute/path/to/reviewed/runtime-templates \
bun run pcd -- serve --dir ./pc_data --http 127.0.0.1:8090
```

In another terminal, create the owner key through the private local socket, then
issue a scoped backend key:

```sh
export POCKETCODER_URL=http://127.0.0.1:8090
export POCKETCODER_KEY=$(bun run pcd -- superuser create --dir ./pc_data --json | jq -r .token)

bun run pcd principals create --name my-backend --scopes templates:read,workspaces:create,workspaces:read,workspaces:cancel,workspaces:preserve,workspaces:restore,checkpoints:read,checkpoints:delete,outputs:read,conversations:read,conversations:delete,services:relay,attachments:write,logs:read,network:read,terminal:attach,terminal:read --templates '*' --json
bun run pcd keys issue --principal-id <returned-id> --request-id <operation-id> \
  --scopes templates:read,workspaces:create,workspaces:read,workspaces:cancel,workspaces:preserve,workspaces:restore,checkpoints:read,checkpoints:delete,outputs:read,conversations:read,conversations:delete,services:relay,attachments:write,logs:read,network:read,terminal:attach,terminal:read \
  --templates '*' \
  --expires "$(bun -e 'console.log(new Date(Date.now() + 3_600_000).toISOString())')" --json
```

Issuance requires explicit scopes, a request ID and an expiry inside the calling
key's remaining lifetime. Omitting `--templates` snapshots the principal's current
grants. Change a principal's grants with `pcd principals update --id
<principal-id> --scopes ...`; pass `keys issue --scopes ...` for a key-specific
restriction.

For the included Pi harness, the repository convenience builds and
materializes that runtime catalog before starting the gateway and server:

```sh
OPENAI_API_KEY=... OPENAI_MODEL=... \
bun run local:up -- --template pi-harness --openai
```

To manage the server independently, run `local:prepare`, keep
`local:gateway` in a separate terminal, configure
`POCKETCODER_TEMPLATE_DIR`/`POCKETCODER_SECRET_ROOT`, and use `pcd server
start|status|stop`; see the [getting-started guide](docs/getting-started.md).

Then add the backend key to `.env` in the repository root:

```dotenv
POCKETCODER_URL=http://127.0.0.1:8090
POCKETCODER_KEY=pkt_…
```

The CLI discovers this file automatically:

```sh
bun run pcd -- workspaces create --template claude-code-agent --wait
bun run pcd -- workspaces list --active
bun run pcd -- workspaces logs --id $WS
bun run pcd -- workspaces chat --id $WS
bun run pcd -- workspaces terminal --id $WS
bun run pcd -- workspaces preserve --id $WS

# Converse through the relay once the workspace is ready:
curl -s -X POST "$POCKETCODER_URL/v1/workspaces/$WS/agent/message" \
  -H "Authorization: Bearer $POCKETCODER_KEY" -H "content-type: application/json" \
  -d '{"content":"fix the failing test"}'

# Durable history remains available after the relay closes:
curl -s "$POCKETCODER_URL/v1/workspaces/$WS/conversation?limit=100" \
  -H "Authorization: Bearer $POCKETCODER_KEY"
```

The OpenAPI document is served at `/v1/openapi.json`. The candidate workflow
publishes six image roles under `ghcr.io/<owner>/<repo>/` after native scans and
role smoke pass. Tags identify the full source commit. See
[candidate images](docs/candidate-images.md); it does not publish stable or version tags.

## Commands

```sh
bun run check       # Biome, knip, and package-boundary checks
bun run format      # format supported files with Biome
bun run test        # unit + integration + example + policy suites
bun run test:unit   # package test suites through Lerna only
bun run typecheck   # strict TypeScript across the Lerna workspace
bun run build       # bundle packages through Lerna with Nx caching
bun run pack:check  # pack the published packages and inspect their tarballs
bun run db:generate -- --name=<change>  # generate a Drizzle migration
bun run packages    # list packages managed by Lerna
bun run start       # pocketcoder-server
bun run pcd -- server start|status|stop  # manage only the configured server process
bun run pcd -- …    # pcd
bun run local:prepare -- --template pi-harness --openai  # build/materialize only
bun run local:gateway -- --openai  # host gateway only
bun run local:up -- --template pi-harness --openai  # persistent local Pi deployment convenience
bun run example:e2e:local  # disposable full-stack E2E with the echo harness
bun run example:e2e:pi     # remote Pi reads a workspace fixture through AgentAPI
bun run example:e2e:codex  # real Codex CLI through AgentAPI and the live relay
bun run example:e2e:opencode # real OpenCode ACP harness through AgentAPI
bun run example:e2e:oss    # combined Codex and OpenCode full-stack matrix
bun run example:pi:ui      # local Pi TUI connected to that remote agent (uses OpenAI)
```

Bun installs and links workspace dependencies and runs each package's scripts.
Lerna coordinates tasks across `packages/*` and the private
`examples/harnesses/*` packages; its Nx integration
provides the project graph and task cache configured in `nx.json`.

The PGlite memory and disk suites run without an external database. Linux
database tests also require `strace` for the real seed durability ordering
regression. That Linux-only regression is skipped on Darwin. Docker suites
require a running daemon, and
`POCKETCODER_KUBERNETES_CONFORMANCE=1` runs the real-cluster driver probe.

Harness and client integrations live under [`examples/`](examples/). The
deterministic Pi E2E runs the remote Pi CLI through AgentAPI and proves a real
workspace file read. The interactive variant runs Pi on the host as the UI,
while the coding agent and tools remain inside the workspace. Consumer
applications remain separate projects and integrate through the machine API.

## Releasing packages

Three npm packages are public:

| Package | What it is |
|---------|------------|
| `@pstdio/pocketcoder-cli` | the `pcd` operator and diagnostics CLI |
| `@pstdio/pocketcoder-remote` | Pi-based terminal UI for workspaces |
| `@pstdio/pocketcoder-sdk` | Node ESM and TypeScript client for the control plane |

Every other workspace remains private, is linked by Bun with `workspace:*`, and
is imported through its `@pstdio/pocketcoder-*` package boundary. Published
packages bundle the private packages they use at build time, so they do not
declare a private workspace dependency at runtime — `bun run check` fails if
one ever does. The server, agent, and egress proxy are distributed as container
images.

`packages/remote` ships two bundles: the launcher and the extension entry that
Pi loads with jiti at runtime. Only `@earendil-works/*` stays external, because
the extension shares those modules with the Pi process hosting it.

`packages/sdk` ships Node ESM and bundled TypeScript declarations. Its only
runtime dependency is `zod`; private workspace packages are bundled. The
package check installs its tarball in a clean project, type-checks a consumer,
and runs that consumer with Node.

The `Release Packages` workflow and Changesets configuration version and
publish only non-private packages. Add a changeset whenever a change affects a
published package's behavior, API, contracts, or packaged output; do not add
changesets for private-package-only tests or refactors:

```sh
bun run changeset
```

After changes land on `main`, `Release Packages` opens or updates a version pull
request for non-private packages only. Merging that pull request publishes the
packages and creates a package tag and GitHub release for each one. A CLI
release also pushes the matching `v<cli-version>` tag. That tag build publishes
multi-architecture server, workspace, and egress images and records their
immutable digests on the release.

For tokenless publishing, configure an npm trusted publisher for each published
package, using organization `pufflyai`, repository `pocketcoder`, and workflow
filename `release-packages.yml`.

A package that has never been published cannot use trusted publishing for its
first release: npm requires the package to exist before a trusted publisher can
be attached to it, and OIDC-only runs fail with `ENEEDAUTH`. Bootstrap a new
package once outside this workflow with a short-lived token, then configure its
trusted publisher. Do not keep a publish token in the repository.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `POCKETCODER_STORE` | `postgres` with a database URL, else `pglite` | Store driver |
| `POCKETCODER_DATABASE_URL` | none | PostgreSQL URL; selects the PostgreSQL store |
| `POCKETCODER_DATABASE_SCHEMA` | `pocketcoder` | Schema for all PocketCoder tables |
| `POCKETCODER_DIR` | `./pc_data` | Private controller folder; with PGlite it also holds the database |
| `POCKETCODER_JOURNAL_DIR` | PGlite: recorded folder; PostgreSQL: required | Deletion journal outside the data folder |
| `POCKETCODER_AUTH_PEPPER` | PGlite: generated key bundle; PostgreSQL: required | Keyed digest secret for machine keys |
| `POCKETCODER_EVENT_SIGNING_KEY` | pepper | HMAC key for lifecycle event signatures |
| `POCKETCODER_EVENT_SINK_URL` | none | Callback URL for signed lifecycle events |
| `POCKETCODER_TEMPLATE_DIR` | none | Directory of reviewed template manifests |
| `POCKETCODER_HOST` / `POCKETCODER_PORT` | `127.0.0.1` / `8090` | Operator listen address |
| `POCKETCODER_AGENT_HTTP` | `0.0.0.0:8091` | Separate agent listener |
| `POCKETCODER_WORKSPACE_SERVER_URL` | Docker: `http://host.docker.internal:8091` | Agent origin workspaces use to reach the server |
| `POCKETCODER_MAX_ACTIVE_WORKSPACES` | `100` | Global concurrency limit |
| `POCKETCODER_MAX_ACTIVE_PER_PRINCIPAL` | `20` | Per-principal concurrency limit |
| `POCKETCODER_MAX_QUEUED_WORKSPACES` | `1000` | Durable queue bound |


## License

[MIT](LICENSE)
