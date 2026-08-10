# `@pstdio/pocketcoder-memory-store`

An in-memory implementation of PocketCoder's runtime store.

## Why it exists

Local development and focused tests need the real store behavior without
requiring PostgreSQL. This adapter provides that fast, disposable option while
implementing the same contract as the production store.

## What it does

- Stores principals, keys, templates, workspaces, conversations, logs,
  persistence records, warm pools, terminal audits, and outbox events in the
  server process.
- Implements admission, state transitions, limits, pagination, and lifecycle
  methods expected by the runtime.
- Supports the control plane when `POCKETCODER_STORE=memory` is set.

All data disappears when the process exits. Use `@pstdio/pocketcoder-db` when
state must survive restarts or be shared by a deployment.
