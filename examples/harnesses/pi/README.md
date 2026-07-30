# Pi harness

This example uses the pinned
`@earendil-works/pi-coding-agent` SDK directly. It exposes PocketCoder's
allowlisted conversation contract on loopback:

- `GET /status`
- `GET /messages`
- `POST /message`

Pi remains a harness dependency, not a PocketCoder control-plane dependency.

## Validate the adapter

```sh
cd examples/harnesses/pi
bun install --frozen-lockfile
bun run typecheck
bun test
```

## Run the full local E2E

No credentials are needed for the deterministic Pi SDK path:

```sh
bun run example:e2e:pi
```

This starts a tiny OpenAI-compatible fake gateway on the host. Pi still parses
the request and streaming response through its real SDK; only the model answer
is fixed.

To test a real OpenAI Chat Completions-compatible gateway, set both variables.
The gateway must be reachable from a workspace container; local gateways
normally use `host.docker.internal`, not `127.0.0.1`:

```sh
PI_GATEWAY_URL=http://host.docker.internal:8080/v1 \
PI_GATEWAY_MODEL=your-model-id \
bun examples/e2e/local.ts --harness pi
```

The example sends a fixed non-secret gateway credential. This is appropriate
for an internal development gateway that ignores client credentials and owns
the real provider secret. A production deployment should resolve a reviewed
`secretRef:` through its deployment secret mechanism; never place provider
credentials in a template or `launch_input`.

The checked-in template contains a placeholder image digest and gateway model.
The local runner replaces both in a generated template. For a deployed setup,
build from the repository root with
`docker build -f examples/harnesses/pi/Dockerfile -t pocketcoder-pi:dev .`,
push the image, replace `spec.image` with the registry digest, set the
gateway/model fields, validate with `pocketcoderctl templates validate`, and
mount the resulting template into `POCKETCODER_TEMPLATE_DIR`.
