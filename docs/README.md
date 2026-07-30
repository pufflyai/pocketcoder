# pocketcoder documentation

pocketcoder is an MIT-licensed, lightweight control plane for coding agents in
isolated workspaces: reviewed **templates** define coding-agent environments,
**workspaces** are isolated instances of them, and one machine-authenticated
API drives the whole lifecycle.

| Guide | What it covers |
|-------|----------------|
| [Getting started](getting-started.md) | Run the server, create a principal and key, launch your first workspace |
| [CLI reference](cli.md) | Every `pocketcoderctl` command with examples |
| [Templates](templates.md) | The template contract: images, setup commands, harnesses, relay routes, security |
| [HTTP API](api.md) | Machine auth, workspace lifecycle, the service relay, signed events |
| [Deployment](deployment.md) | Container images, docker compose, PostgreSQL placement, configuration reference |
| [Agent examples](../examples/README.md) | Full-stack harness E2E and local Pi as the UI for a remote AgentAPI session |
| [Architecture](architecture.md) | Components, workspace state machine, agent protocol |

## The short version

```sh
# 1. Run the control plane (in-memory store for a quick look)
POCKETCODER_STORE=memory POCKETCODER_TEMPLATE_DIR=deploy/templates bun run start

# 2. Operators manage principals/keys/templates with pocketcoderctl
pocketcoderctl principals create --name my-backend --scopes workspaces:create,workspaces:read,workspaces:cancel,services:relay,templates:read,logs:read --templates '*'
pocketcoderctl keys issue --principal my-backend --expires never   # shown once

# 3. Callers (your backend, or the CLI) drive workspaces
export POCKETCODER_URL=http://127.0.0.1:7080 POCKETCODER_KEY=pkt_…
pocketcoderctl workspaces create --template claude-code-agent
pocketcoderctl workspaces list --active
pocketcoderctl workspaces logs --id <uuid>
pocketcoderctl workspaces cancel --id <uuid>
```

Every workspace follows one execution path: server → durable queue → driver
(Docker locally, Kubernetes planned for production) → one isolated container →
`pocketcoder-agent` (PID 1) → your template's harness (typically AgentAPI
wrapping a coding-agent CLI).
