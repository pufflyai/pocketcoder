# Pi through AgentAPI

This example exercises PocketCoder's intended coding-agent integration path:

```text
local client → PocketCoder → AgentAPI → remote Pi CLI → model gateway
```

PocketCoder launches AgentAPI and owns its loopback HTTP lifecycle (`GET
/status`, `GET /messages`, and `POST /message`). The template declares only
`run-pi`, which configures and starts Pi as the interactive child. There is no
consumer-owned AgentAPI wrapper or PocketCoder-specific Pi HTTP adapter.

The image pins Pi to `0.83.0` and AgentAPI to `0.12.2`. The Dockerfile verifies
AgentAPI's downloaded checksum for both supported Linux architectures.
AgentAPI does not yet include a native Pi terminal profile, so
`agentapi-compat.ts` displays a `>` immediately above Pi's editor for
AgentAPI's generic input-readiness detector. It does not implement HTTP routes,
store messages, or invoke Pi.

The image also stores a test fixture at `/opt/pocketcoder-fixtures/test.txt`.
The template's `setup` step copies it into the tmpfs-backed
`/workspace/test.txt` before AgentAPI and Pi start.

## Validate the fixture

```sh
cd examples/harnesses/pi
bun install --frozen-lockfile
bun run typecheck
bun test
```

## Run the full local E2E

No credentials are needed for the deterministic path:

```sh
bun run example:e2e:pi
```

This starts a tiny OpenAI-compatible fake gateway on the host. The gateway
requests Pi's real `read` tool, Pi reads `/workspace/test.txt`, and the test
verifies the returned fixture text. AgentAPI still drives Pi through its
terminal and serves the conversation API.

To test a real OpenAI connection without opening the interactive UI:

```sh
OPENAI_API_KEY=... OPENAI_MODEL=... bun run example:e2e:pi:openai
```

This starts a short-lived gateway on the host, keeps `OPENAI_API_KEY` out of
the workspace, and forwards the remote Pi agent's requests to the OpenAI
Responses API. `OPENAI_MODEL` is required; `OPENAI_ORGANIZATION` and
`OPENAI_PROJECT` are forwarded when set.

To test a different OpenAI-compatible gateway, set both variables.
The gateway must be reachable from a workspace container; local gateways
normally use `host.docker.internal`, not `127.0.0.1`:

```sh
PI_GATEWAY_URL=http://host.docker.internal:8080/v1 \
PI_GATEWAY_MODEL=your-model-id \
bun examples/e2e/local.ts --harness pi
```

`PI_GATEWAY_API` selects `openai-completions` (the default) or
`openai-responses`. `PI_GATEWAY_BEARER` is the workspace-to-gateway
credential. In a deployment template, set it to a `secretRef:` so PocketCoder
projects only that key as a read-only file. Never place a provider credential
in a template or `launch_input`.

[`gateway.Dockerfile`](./gateway.Dockerfile) packages the example OpenAI gateway.
It enforces one bearer, model, text-only policy, expiry, output cap, and bounded
request counts and bytes. The [DigitalOcean Pi guide](../../../deploy/digitalocean/PI.md)
shows how to deploy it for one short-lived workspace session. A shared or paid
service still needs durable identity, usage, revocation, and budget controls.

## Open the workspace agent in local Pi

From the repository root:

```sh
OPENAI_API_KEY=... OPENAI_MODEL=... bun run example:pi:ui
```

This opens a Pi TUI on the host using
[`@pstdio/pocketcoder-remote`](../../../packages/remote/).
The local Pi process disables its own coding tools and sends turns through
PocketCoder's relay to AgentAPI. The coding agent and all file operations stay
inside the disposable workspace. Exit Pi to cancel the workspace.

The shared checked-in
[`pi-harness` template](../../templates/pi-harness.json) contains a placeholder
image digest and gateway model. The local runner replaces both in a generated
template. For a deployed setup, build from the repository root with
`docker build -f examples/harnesses/pi/Dockerfile -t pocketcoder-pi:dev .`,
push the image, replace `spec.image` with the registry digest, set the
gateway/model fields, validate with `pcd templates validate`, and
mount the resulting template into `POCKETCODER_TEMPLATE_DIR`.
