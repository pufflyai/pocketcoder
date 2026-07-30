# PocketCoder examples

This directory is the integration boundary for exercising PocketCoder with
real harnesses.

## What is here

- [`e2e/`](e2e/) contains a reusable harness contract test. It creates a
  workspace, waits for readiness, sends a message through the allowlisted
  relay, observes the response, cancels the workspace, and verifies the
  terminal state.
- [`harnesses/echo/`](harnesses/echo/) is deterministic and credential-free.
  It is the default local smoke test.
- [`harnesses/pi/`](harnesses/pi/) adapts the Pi SDK directly to PocketCoder's
  three-route conversation contract. It uses the same E2E runner but requires
  an OpenAI-compatible model gateway.

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

The same full path with the real, pinned Pi SDK and a deterministic local model
gateway is:

```sh
bun run example:e2e:pi
```

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
