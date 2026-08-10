# `@pstdio/pocketcoder-runtime-core`

The deployment-neutral application logic for the PocketCoder control plane.

## Why it exists

Workspace lifecycle rules must behave the same with every database and
provider. This package keeps scheduling and reconciliation separate from HTTP,
PostgreSQL, Docker, and Kubernetes code.

## What it does

- Admits queued work, enforces capacity and fairness limits, and advances
  workspace lifecycle state.
- Loads and validates the template registry.
- Dispatches durable outbox events.
- Reconciles recorded workspaces, storage, checkpoints, and provider objects
  after restarts.
- Creates and claims warm-pool runtimes.
- Records runtime metrics through a small metrics interface.

The server supplies implementations of the store, workspace driver, storage
driver, and secret resolver ports defined by `runtime-contracts`.
