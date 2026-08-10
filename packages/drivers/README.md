# `@pstdio/pocketcoder-drivers`

Infrastructure adapters that create and inspect PocketCoder workspaces.

## Why it exists

Scheduling rules should not depend on Docker commands, Kubernetes objects, or
physical storage paths. These adapters translate the runtime's neutral ports
into deployment-specific operations.

## What it does

- Starts, inspects, stops, discovers, and removes workspace and warm-pool
  runtimes with Docker or Kubernetes.
- Allocates persistent workspace storage and checkpoints on the local
  filesystem or a Kubernetes persistent volume claim.
- Resolves runtime and source secrets from files or Kubernetes Secrets.
- Adds the restricted-network egress sidecar and its short-lived audit token
  when a template requires it.

The server selects one runtime driver from deployment configuration. API
callers and templates cannot choose a driver.
