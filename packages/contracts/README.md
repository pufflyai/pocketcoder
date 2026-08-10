# `@pstdio/pocketcoder-contracts`

Runtime schemas and public protocol contracts for PocketCoder.

## Why it exists

The server, agent, SDK, CLI, and drivers exchange the same data across process
boundaries. A single contract package prevents those components from accepting
different shapes or interpreting workspace state differently.

## What it does

- Defines Zod schemas and TypeScript types for templates, workspaces,
  persistence, conversations, terminals, attachments, and network policy.
- Defines agent and server WebSocket frames, protocol versions, event
  envelopes, API errors, scopes, pagination, and resource schemas.
- Provides template parsing, normalization, validation, rendering, and stable
  snapshot helpers.
- Provides small shared helpers for canonical JSON, hashes, and duration
  parsing.

The package describes data and validates boundaries. It does not start
workspaces, perform I/O, or contain deployment-specific behavior.
