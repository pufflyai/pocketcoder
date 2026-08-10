# `@pstdio/pocketcoder-supervisor`

The supervisor that runs as PID 1 inside every PocketCoder workspace.

## Why it exists

Every workspace needs one trusted process to connect an isolated runtime to the
PocketCoder control plane. Keeping that lifecycle in one supervisor gives all
agent harnesses the same setup, health, relay, and shutdown behavior.

## What it does

- Reads the workspace's launch input and registers with `pocketcoder-server`
  over one outbound WebSocket connection.
- Runs template setup, starts the configured harness, and monitors its health.
- Relays logs, AgentAPI traffic, attachments, terminals, and proxy streams.
- Quiesces the workspace for checkpoints and shuts child processes down in a
  controlled order.

Workspace images include the compiled `pocketcoder-supervisor` binary and use
the `supervise` command as their entrypoint. It is a private runtime package,
not a library for workspace code.
