# PocketCoder examples

Native session producers send typed text, tool calls, tool results, errors, and file metadata. The CLI, SDK, and Prompt Studio clients consume canonical conversations. Session clients do not parse terminal output.

- [`harnesses/echo/`](harnesses/echo/) is deterministic and needs no credentials.
- [`harnesses/pi/`](harnesses/pi/) runs Pi 0.87.1 through JSON RPC.
- [`harnesses/onefin/`](harnesses/onefin/) redeems a one-time Onefin bootstrap and runs native Pi with the scoped Onefin provider.
- [`e2e/`](e2e/) exercises requests, live conversation events, retained history, cancellation, checkpoints, and real drivers.
- [`local/`](local/) builds templates from image-owned artifact descriptors and runs a host model gateway with separate workspace leases.
- [`templates/`](templates/) contains illustrative manifests. Their image and artifact digests are placeholders. Materialize them from an installed image before publishing.

## Disposable local checks

From the repository root:

```sh
bun run example:e2e:local
bun run example:e2e:pi
```

These commands create a controller, a Docker workspace, finite host keys, and an immutable template. They send native requests, read canonical messages, and cancel the workspace. Pi uses a deterministic model gateway and reads `/workspace/test.txt` with its real `read` tool. The Pi check also verifies four identical replies with distinct message IDs.

For a host OpenAI gateway:

```sh
OPENAI_MODEL=your-model bun run example:e2e:pi:openai
```

Set `OPENAI_API_KEY` on the host. It never enters the workspace. Each workspace receives an expiring gateway lease through a credential slot. Teardown revokes that lease.

The retired terminal integrations for Codex and OpenCode are removed. A new agent integration must implement the native producer contract or use the Prompt Studio relay connection.

## Persistent local Pi

```sh
OPENAI_MODEL=your-model bun run local:up -- --template pi-harness --openai
```

The command builds and publishes a template, runs the host gateway and issuer, and starts a controller. Host keys and controller data live under `~/.local/share/pocketcoder/local-pi`. Generated templates live under `.pocketcoder/local/templates`. Use an operator key from that controller in another terminal:

```sh
pcd templates list
pcd workspaces create --template pi-harness --wait
pcd workspaces chat --id <workspace-id>
pcd workspaces cancel --id <workspace-id>
```

`local:prepare` only builds an image and writes a native template. `local:gateway` runs a standalone gateway and prints the host issuer configuration and CA paths. Configure that issuer in the controller vault as `pi-gateway` before using the prepared template. Provider keys and issuer authorization stay on the host.

## Test a deployed template

```sh
POCKETCODER_URL=http://127.0.0.1:8090 \
POCKETCODER_KEY=<host-operator-key> \
POCKETCODER_EXAMPLE_TEMPLATE=my-template \
bun run example:e2e
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `POCKETCODER_EXAMPLE_PROMPT` | `Reply with: pocketcoder example ok` | Native request message |
| `POCKETCODER_EXAMPLE_EXPECT` | none | Required response text |
| `POCKETCODER_EXAMPLE_READY_TIMEOUT_MS` | `120000` | Workspace readiness deadline |
| `POCKETCODER_EXAMPLE_MESSAGE_TIMEOUT_MS` | `300000` | Request completion deadline |

See the [session contract](../docs/agent-transport-decision.md), [image qualification](../docs/candidate-images.md), and [checkpoint runbook](../docs/docker-checkpoint-round-trip.md).
