# `@pstdio/pocketcoder-runtime-contracts`

Driver-neutral ports and durable row contracts for the PocketCoder runtime.

## Why it exists

The scheduler and adapters need a shared vocabulary without depending on each
other's implementations. This package is the dependency boundary that lets the
runtime work with PostgreSQL or memory and with Docker or Kubernetes.

## What it does

- Defines the combined store interface and its auth, workspace, template,
  conversation, log, persistence, terminal, warm-pool, and outbox ports.
- Defines durable row and mutation types used by store implementations.
- Defines workspace, storage, checkpoint, secret, and warm-runtime driver
  interfaces.
- Builds typed lifecycle event envelopes.

This package contains contracts, not scheduling or infrastructure behavior.
Implementations live in `runtime-core`, `db`, `memory-store`, and `drivers`.
