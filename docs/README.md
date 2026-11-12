# pocketcoder documentation

pocketcoder is an MIT-licensed, lightweight control plane for coding agents in
isolated workspaces: reviewed **templates** define coding-agent environments,
**workspaces** are isolated instances of them, and one machine-authenticated
API drives the whole lifecycle.

| Guide | What it covers |
|-------|----------------|
| [Continuous integration](ci.md) | Fast PR checks, full merge qualification, caches, branch rules, and timing |
| [Getting started](getting-started.md) | Run the server, create a principal and key, launch your first workspace |
| [CLI reference](cli.md) | Every `pcd` command with examples |
| [Templates](templates.md) | The template contract: images, setup commands, native coding agents, terminals, egress, security |
| [Private source](private-source.md) | Scoped Git setup leases, issuer contract and real provider checks |
| [Runtime credentials](runtime-credentials.md) | Renewable workspace authority and cleanup on both providers |
| [HTTP API](api.md) | Machine auth, workspace lifecycle, structured sessions, terminals, attachments, signed events |
| [Checkpoint API](checkpoint-api.md) | Attach, preserve, restore and list the routes that operate on saved state |
| [Attachments and input storage](input-storage.md) | How uploaded bytes become immutable, bounded workspace input |
| [Admission feedback](admission.md) | The `reason_code` values a queued workspace reports while limits or policy block it |
| [Cleanup and purge](cleanup.md) | Termination, content purge and key revocation as separate operations |
| [Conversation identities](conversation-identities.md) | The caller-owned identity envelope and explicit conversation outcomes |
| [Source layout](source-layout.md) | Feature directories, dependencies, and contributor workflow |
| [Architecture](architecture.md) | Components, database schema, workspace state machine, agent protocol |
| [Agent transport decision](agent-transport-decision.md) | Why templates keep PTY/ACP and what must be true before another transport is added |
| [Manager recovery](manager-recovery.md) | Encrypted manager backup, deletion replay, writer transfer and restart |
| [Hosted node recovery](hosted-node-recovery.md) | Backup schedules, prepared production cost/layout, source fencing and required failure evidence |
| [Off-node account recovery](off-node-account-recovery.md) | Encrypted account capture, fresh-volume restore and writer transfer |
| [Managed account upgrades](managed-account-upgrades.md) | Upgrading one managed account without touching the others |
| [Monitoring](monitoring.md) | Manager metrics, health sampling and hosted alert rules |
| [Deployment](deployment.md) | Container images, docker compose, Kubernetes, data folder, configuration reference |
| [Kubernetes shared storage](kubernetes-shared-storage.md) | The `kubernetes-shared` backend, required filesystem and PV rules |
| [Candidate images](candidate-images.md) | The six image roles, native scans and the candidate tag rules |
| [Candidate installation](candidate-installation.md) | Native executable and package artifacts from one passing commit |
| [Security model](security.md) | Trust zones, credential lifetime rules, what the deployment's model gateway must enforce |
| [Durable conversation validation](durable-conversation-validation.md) | Automated and manual checks for history, retention, deletion, and resume behavior |
| [Docker checkpoint round trip](docker-checkpoint-round-trip.md) | Local CLI/API archive transfer, verified restore, readiness and cleanup checks |
| [Migration guide](migration.md) | Frozen legacy rename map, in-place upgrade from 0.8.x on PostgreSQL |
| [Release checklist](release.md) | Shipped migrations stay unchanged; every release upgrades the previous one in place |
| [Agent examples](../examples/README.md) | Full-stack harness E2E |

One client package sits on top of the machine API:

| Package | What it is |
|---------|------------|
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
`pocketcoder-supervisor` (PID 1) → a native session producer → your template's
coding-agent command.

Run `bun run test` for the full suite. It runs the browser, unit, performance,
integration, deployment, example, and policy checks in that order. The warm-pool
benchmark measures 40 real admissions, includes first-use costs, and keeps the
80% p95 target. Running it alongside builds or other tests adds CPU scheduling
delays to the measured database work.

- [Connect a managed consumer](managed-consumers.md)
