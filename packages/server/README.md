# `@pstdio/pocketcoder-server`

The PocketCoder control-plane server.

## Why it exists

PocketCoder needs one authority to accept API requests, schedule isolated
workspaces, and keep their state consistent across process and infrastructure
failures. This application brings those control-plane parts together.

## What it does

- Serves the Hono REST, OpenAPI, WebSocket, service relay, and terminal APIs.
- Authenticates machine keys and enforces scopes and template access.
- Loads templates, admits work, schedules workspace runtimes, and manages warm
  pools.
- Uses Docker or Kubernetes drivers and optional storage and secret adapters.
- Stores state in PostgreSQL for deployments or in memory for local
  development.
- Dispatches durable events and reconciles database state with provider state
  after startup.

Run it from the repository root with `bun run start`. Deployment and
configuration details live in [`docs/deployment.md`](../../docs/deployment.md).
