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
| [HTTP API](api.md) | Machine auth, workspace lifecycle, the AgentAPI relay, terminals, attachments, signed events |
| [Architecture](architecture.md) | Components, database schema, workspace state machine, agent protocol |
| [Agent transport decision](agent-transport-decision.md) | Why templates keep PTY/ACP and what must be true before another transport is added |
| [Deployment](deployment.md) | Container images, docker compose, Kubernetes, PostgreSQL placement, configuration reference |
| [Security model](security.md) | Trust zones, credential lifetime rules, what the deployment's model gateway must enforce |
| [Durable conversation validation](durable-conversation-validation.md) | Automated and manual checks for history, retention, deletion, and resume behavior |
| [Migration guide](migration.md) | Frozen legacy rename map and a one-pass consumer migration checklist |
| [Agent examples](../examples/README.md) | Full-stack harness E2E and local Pi as the UI for a remote AgentAPI session |

Two clients sit on top of the same machine API:

| Package | What it is |
|---------|------------|
| [`@pstdio/pocketcoder-remote`](../packages/remote/README.md) | Local Pi as a thin terminal client for a workspace, with history replay, attachments, and workspace commands — published to npm |
| [`@pstdio/pocketcoder-sdk`](../packages/sdk/README.md) | Published Node ESM and TypeScript client for the control plane, with runtime validation and no private workspace dependencies |

## The short version

```sh
# 1. Run the control plane (in-memory store for a quick look)
POCKETCODER_STORE=memory bun run pcd -- server start --foreground

# 2. Operators manage principals/keys/templates with pcd
pcd principals create --name my-backend --scopes templates:read,workspaces:create,workspaces:read,workspaces:cancel,conversations:read,services:relay,attachments:write,logs:read,terminal:attach,terminal:read --templates '*'
pcd keys issue --principal my-backend --expires 2027-01-01T00:00:00Z   # shown once; bounded — rotate, don't reissue forever

# 3. Callers (your backend, or the CLI) drive workspaces
export POCKETCODER_URL=http://127.0.0.1:7080 POCKETCODER_KEY=pkt_…
pcd workspaces create --template claude-code-agent
pcd workspaces list --active
pcd workspaces logs --id <uuid>
pcd workspaces terminal --id <uuid>
pcd workspaces cancel --id <uuid>
```

Every workspace follows one execution path: server → durable queue → driver
(Docker locally, Kubernetes Jobs in-cluster) → one isolated runtime →
`pocketcoder-agent` (PID 1) → PocketCoder-owned AgentAPI → your template's
coding-agent command.
