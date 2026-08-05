# Codex and OpenCode E2E harnesses

This fixture image runs the real Codex and OpenCode CLIs behind AgentAPI and
PocketCoder's workspace supervisor. The repository pins Codex `0.134.0`,
OpenCode `1.0.98`, AgentAPI `0.12.2`, and the OpenAI-compatible provider used
by OpenCode so CI exercises a reproducible integration boundary.

Codex uses AgentAPI's native PTY adapter. OpenCode uses its native `acp`
command and AgentAPI's experimental ACP adapter; this avoids launching the
OpenTUI frontend and preserves the template's read-only root and no-exec tmpfs
security policy.

From the repository root:

```sh
bun run example:e2e:codex
bun run example:e2e:opencode
bun run example:e2e:oss
```

The tests create a disposable PostgreSQL database, workspace image, server,
and authenticated local model gateway. Each run mints a random bearer that is
valid only for that gateway process. Both harnesses must emit multiple live
AgentAPI snapshots, return the exact deterministic response, cancel the
workspace, and clean up their temporary resources.
