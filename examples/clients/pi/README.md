# Local Pi UI for a PocketCoder workspace

This client keeps the coding agent in the remote workspace:

```text
local Pi TUI
  → PocketCoder service relay
  → AgentAPI
  → remote coding agent
```

`remote-agentapi.ts` registers AgentAPI as a custom Pi provider and disables
Pi's local coding tools. Messages typed into the local Pi UI are sent to the
remote AgentAPI session; the returned agent message is rendered as the local
assistant turn. The extension does not start, parse, or emulate a coding-agent
process.

Install the pinned local client once:

```sh
cd examples/clients/pi
bun install --frozen-lockfile
```

Then connect it to a ready workspace:

```sh
POCKETCODER_URL=http://127.0.0.1:7080 \
POCKETCODER_KEY=pkt_... \
POCKETCODER_WORKSPACE_ID=... \
bun run start
```

The selected workspace template must expose AgentAPI's `GET /status`,
`GET /messages`, and `POST /message` routes as its `agent` service. The machine
key stays on the local machine.
