# pocketcoder documentation

pocketcoder is an MIT-licensed, lightweight control plane for coding agents in
isolated workspaces: reviewed **templates** define coding-agent environments,
**workspaces** are isolated instances of them, and one machine-authenticated
API drives the whole lifecycle.

| Guide | What it covers |
|-------|----------------|
| [Getting started](getting-started.md) | Run the server, create a principal and key, launch your first workspace |
| [CLI reference](cli.md) | Every `pcd` command with examples |
| [Templates](templates.md) | The template contract: images, setup commands, native coding agents, terminals, egress, security |
| [Private source](private-source.md) | Scoped Git setup leases, issuer contract and real provider checks |
| [Runtime credentials](runtime-credentials.md) | Renewable workspace authority and cleanup on both providers |
| [HTTP API](api.md) | Machine auth, workspace lifecycle, the AgentAPI relay, terminals, attachments, signed events |
| [Source layout](source-layout.md) | Feature directories, dependencies, and contributor workflow |
| [Architecture](architecture.md) | Components, database schema, workspace state machine, agent protocol |
| [Agent transport decision](agent-transport-decision.md) | Why templates keep PTY/ACP and what must be true before another transport is added |
| [Deployment](deployment.md) | Container images, docker compose, Kubernetes, data folder, configuration reference |
| [Security model](security.md) | Trust zones, credential lifetime rules, what the deployment's model gateway must enforce |
| [Durable conversation validation](durable-conversation-validation.md) | Automated and manual checks for history, retention, deletion, and resume behavior |
| [Docker checkpoint round trip](docker-checkpoint-round-trip.md) | Local CLI/API archive transfer, verified restore, readiness and cleanup checks |
| [Migration guide](migration.md) | Frozen legacy rename map and a one-pass consumer migration checklist |
| [Agent examples](../examples/README.md) | Full-stack harness E2E and local Pi as the UI for a remote AgentAPI session |

Two clients sit on top of the same machine API:

| Package | What it is |
|---------|------------|
| [`@pstdio/pocketcoder-remote`](../packages/remote/README.md) | Local Pi terminal client, plus a typed embedded adapter for user-turn workspace resume |
| [`@pstdio/pocketcoder-sdk`](../packages/sdk/README.md) | Node ESM client with a reusable resolver for stateless user turns after workspace preservation |

## The short version

For a fresh disposable development environment, run the isolated echo example:

```sh
bun run example:e2e:local
```

It bootstraps a bounded owner, starts the server, creates workload authority over
HTTP, checks the workspace lifecycle, and removes its data afterward. On an
existing running server, use a bounded owner key to create a backend principal
and key; see [getting started](getting-started.md). Callers then use that backend
key through the CLI or SDK. Keep every operator key outside workspaces.

```sh
export POCKETCODER_URL=http://127.0.0.1:8090 POCKETCODER_KEY=pkt_…
pcd workspaces create --template claude-code-agent
pcd workspaces list --active
pcd workspaces logs --id <uuid>
pcd workspaces terminal --id <uuid>
pcd workspaces cancel --id <uuid>
```

Every workspace follows one execution path: server → durable queue → driver
(Docker locally, Kubernetes Jobs in-cluster) → one isolated runtime →
`pocketcoder-supervisor` (PID 1) → PocketCoder-owned AgentAPI → your template's
coding-agent command.

Run `bun run test` for the full suite. It runs unit tests across packages, then
`bun run test:performance` on its own before integration tests. The warm-pool
benchmark measures 40 real admissions, includes first-use costs, and keeps the
80% p95 target. Running it alongside builds or other tests adds CPU scheduling
delays to the measured database work.
