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
- [`clients/pi/`](clients/pi/) turns a Pi instance on the developer's machine
  into the UI for an AgentAPI session in a PocketCoder workspace. Local Pi has
  no coding tools; the remote agent owns all workspace operations.

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
  → pocketcoder-agent over WSS
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

## Use local Pi as the remote agent UI

Set an OpenAI API key on the host and run:

```sh
OPENAI_API_KEY=... OPENAI_MODEL=... bun run example:pi:ui
```

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
