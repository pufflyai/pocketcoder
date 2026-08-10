# PocketCoder examples

This directory is the integration boundary for exercising PocketCoder with
real harnesses.

## What is here

- [`templates/`](templates/) contains illustrative manifests with placeholder
  image references, including the shared
  [`pi-harness`](templates/pi-harness.json) manifest consumed by the Pi E2E
  runner. They are useful for validation and control-plane demos, but are not
  production deployment defaults.
- [`e2e/`](e2e/) contains a reusable harness contract test. It creates a
  workspace, waits for readiness, sends a message through the allowlisted
  relay, observes the response, cancels the workspace, and verifies the
  terminal state.
- [`harnesses/echo/`](harnesses/echo/) is deterministic and credential-free.
  It is the default local smoke test.
- [`harnesses/pi/`](harnesses/pi/) runs the Pi CLI behind AgentAPI, which owns
  PocketCoder's three-route conversation contract. It uses the same E2E runner
  with an OpenAI-compatible model gateway.
- [`harnesses/oss/`](harnesses/oss/) runs the real Codex and OpenCode CLIs
  through AgentAPI. A deterministic local model gateway makes both full-stack
  tests credential-free and verifies incremental response events.
- [`clients/pi/`](clients/pi/) documents the relay conversation contract for
  building your own workspace UI. The maintained local Pi client lives in the
  published package [`@pstdio/pocketcoder-remote`](../packages/remote/); local Pi has
  no coding tools, and the remote agent owns all workspace operations.
- [`local/`](local/) materializes a persistent digest-pinned Pi runtime for the
  optional repository `local:up` workflow. Generated templates and secrets live
  under ignored `.pocketcoder/local/`, never in this source directory.

## Persistent local Pi workflow

With PostgreSQL, a migrated PocketCoder schema, and an issued machine key
already configured:

```sh
OPENAI_API_KEY=... OPENAI_MODEL=... \
bun run local:up -- --template pi-harness --openai
```

In another terminal:

```sh
pcd templates list
pcd workspaces create --template pi-harness --wait
pcd workspaces chat --id <workspace-id>
pcd workspaces cancel --id <workspace-id>
```

`local:up` is repository/deployment convenience. `pcd server start` is
separate and starts only an already configured PocketCoder server.

The same setup with an independently managed server is:

```sh
# Build/inspect the image and render .pocketcoder/local/{templates,secrets}.
OPENAI_MODEL=<model> \
bun run local:prepare -- --template pi-harness --openai

# Keep this host gateway running in its own terminal.
OPENAI_API_KEY=<key> OPENAI_MODEL=<model> \
bun run local:gateway -- --openai

# Start only PocketCoder, using the prepared operator-owned inputs.
POCKETCODER_TEMPLATE_DIR="$PWD/.pocketcoder/local/templates" \
POCKETCODER_SECRET_PROVIDER=file \
POCKETCODER_SECRET_ROOT="$PWD/.pocketcoder/local/secrets" \
bun run pcd -- server start
```

After that, the ordinary `pcd templates` and `pcd workspaces` commands above
are identical to the convenience workflow. `pcd server stop` stops only the
server; stop the gateway separately with Ctrl-C.

## One-command local E2E

From the repository root:

```sh
bun run example:e2e:local
```

The command creates a temporary PostgreSQL container, builds a locally
content-addressed echo workspace image, starts PocketCoder on the host, and
proves:

```text
REST create
  → PostgreSQL queue
  → Docker driver
  → workspace container
  → pocketcoder-supervisor over WSS
  → echo harness
  → relayed message
  → cancellation and container cleanup
```

Every container, image tag, generated template, key, and database created by the
command has a unique example prefix and is removed on exit.

The same full path with pinned AgentAPI, the real Pi CLI, and a deterministic
local model gateway is:

```sh
bun run example:e2e:pi
```

That test loads `harnesses/pi/workspace/test.txt` into `/workspace`, asks the
remote Pi agent to read it with Pi's real `read` tool, and verifies the result.

The OSS harness matrix exercises both native AgentAPI adapters:

```sh
bun run example:e2e:oss
```

Run one harness while troubleshooting with `bun run example:e2e:codex` or
`bun run example:e2e:opencode`. These commands build the real CLIs into the
workspace image, stream a deterministic response through PocketCoder, require
multiple live updates, and verify the final AgentAPI message. CI runs the
combined matrix.

## Use local Pi as the remote agent UI

Set an OpenAI API key on the host and run:

```sh
OPENAI_API_KEY=... OPENAI_MODEL=... bun run example:pi:ui
```

The interactive workflow keeps background server logs out of Pi's terminal.
Set `POCKETCODER_EXAMPLE_DEBUG=1` to show them while troubleshooting.

The command creates the disposable local PocketCoder stack and workspace,
starts a short-lived host gateway that adds the OpenAI bearer credential, then
opens Pi on the host. The initial message asks the remote agent to read the
test file; you can continue chatting in the same Pi session. Exiting local Pi
cancels the workspace and removes all temporary resources.

The topology is:

```text
local Pi TUI
  → PocketCoder relay
  → AgentAPI
  → remote Pi coding agent
  → host OpenAI gateway
  → OpenAI Responses API
```

The OpenAI key never enters the workspace. `OPENAI_MODEL` is required; the
example never selects a provider model implicitly.

## Test any running harness

When PocketCoder and a template are already deployed:

```sh
POCKETCODER_URL=http://127.0.0.1:7080 \
POCKETCODER_KEY=pkt_... \
POCKETCODER_EXAMPLE_TEMPLATE=my-harness \
bun run example:e2e
```

Optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `POCKETCODER_EXAMPLE_PROMPT` | `Reply with: pocketcoder example ok` | Message sent through the relay |
| `POCKETCODER_EXAMPLE_EXPECT` | none | Substring required in the harness response |
| `POCKETCODER_EXAMPLE_READY_TIMEOUT_MS` | `120000` | Workspace readiness timeout |
| `POCKETCODER_EXAMPLE_MESSAGE_TIMEOUT_MS` | `300000` | Harness response timeout |

See each harness directory for its image and template instructions.
