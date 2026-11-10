# Pi starter for managed sessions

This directory builds a workspace image that runs [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
as a managed-session producer. It has no dependency on the PocketCoder source tree:
copy it, add your tools and instructions, and build it.

## What it contains

| File | Purpose |
| --- | --- |
| `src/execution-adapter.ts` | The `pocketcoder.execution/v1` service: accept, lookup, cancel and ack |
| `src/pi-turn.ts` | Runs one Pi turn in JSON mode in its own process group |
| `src/publication.ts` | Publishes the files a turn saved as immutable result objects |
| `src/model-route.ts` | Points Pi at the deployment's model gateway |
| `write-workload.ts` | Writes the image manifest with the digests of the installed artifacts |
| `Dockerfile` | Builds the image on a digest-pinned PocketCoder workspace image |

Pi is pinned exactly (`0.83.0`, with its `@earendil-works` packages locked at
`0.83.0` in `bun.lock`). Change the version only deliberately.

## How a turn runs

- PocketCoder owns the durable request, its deduplication, cancellation, history and
  recovery. The adapter keeps facts only while the workspace runs. After a restart it
  answers `absent`, and PocketCoder keeps the outcome uncertain instead of re-running work.
- Each turn runs `pi --mode json --print` with `--session-id <session>`, so the turns
  of one session share Pi's conversation. Turns of different sessions run separately.
- The outcome comes from Pi's structured events and stop reason (`completed`,
  `failed` with `model_error`, or `canceled`), never from parsing terminal text.
- A cancel stops only that turn's Pi process group. A cancel that arrives before
  accept stops the turn from ever starting.
- Files the turn saves in its output directory (`/workspace/.pocketcoder/outputs/<turn>`)
  are published with their SHA-256 digests. A canceled or oversized turn publishes an
  incomplete set; nothing is dropped silently.

## Model access

PocketCoder does not provide a model gateway. The deployment runs one, such as
[agentgateway](https://agentgateway.dev/), and the template sets:

- `PI_GATEWAY_URL` and `PI_GATEWAY_MODEL`: the gateway route and model;
- `PI_GATEWAY_BEARER_FILE`: a workspace-scoped, expiring credential file.

The adapter reads the bearer file for every turn and passes it to Pi only in its
environment (`$PI_GATEWAY_BEARER` in `models.json`). It is never written to disk or
put on a command line.

## Build

```sh
docker build \
  --build-arg POCKETCODER_WORKSPACE_IMAGE='ghcr.io/pufflyai/pocketcoder/workspace@sha256:<digest>' \
  -t registry.example/pocketcoder-pi-starter:1 .
```

The build prints the runtime and adapter digests. Put them, and the image digest, into
[`examples/templates/pi-managed.json`](../../../templates/pi-managed.json).

## Known gap

The template delivers the gateway bearer through a `credentialSlot:` reference.
PocketCoder does not yet qualify credential slots for workload templates: publication
refuses them. Until it does, this template validates but cannot be published.
