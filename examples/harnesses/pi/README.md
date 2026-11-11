# Native Pi sessions

The image pins Pi to 0.87.1. PocketCoder uses Pi JSON RPC and emits canonical text, tool, error, and file parts. It keeps Pi context in one session file per conversation. No terminal output is parsed.

Build the image from the repository root:

```sh
docker build -f examples/harnesses/pi/Dockerfile -t pocketcoder-pi:local .
```

`examples/local/session-template.ts` reads the installed image descriptor and builds a template with the actual runtime and producer digests. The JSON template in `examples/templates/` is illustrative; replace its image and artifact pins before publishing.

The model gateway uses a fixed-scope credential slot. The controller mints a separate expiring lease for each workspace. Host provider keys and issuer authority never enter the workspace. The native producer supports request replay, targeted cancellation, and independent conversations.

Run the real Pi CLI against a deterministic local gateway:

```sh
bun run example:e2e:pi
```

Or keep an OpenAI key on the host and run the same path:

```sh
OPENAI_MODEL=your-model bun run example:e2e:pi:openai
```

`session-replies.test.ts` verifies that four identical replies retain distinct canonical message IDs. The image-owned checkpoint hook fences accepted requests before state is captured.
