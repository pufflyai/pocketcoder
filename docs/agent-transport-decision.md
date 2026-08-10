# Agent transport decision

- **Status:** Accepted
- **Date:** 2026-08-10
- **Scope:** Pi, OpenCode, Codex, Claude, AgentAPI, and ACP integration

## Decision

PocketCoder keeps the template-owned `agent.transport` values `pty` and
`acp`. It does not add a Pi-specific JSONL/RPC transport or any server-side
branch on `agent.type`.

AgentAPI remains the fixed HTTP boundary exposed through PocketCoder. A
template chooses the coding-agent command, transport, environment, model
configuration, and any agent-specific files baked into or mounted by its
image. PocketCoder supplies lifecycle, isolation, relay, and durable transcript
storage; it does not generate agent configuration such as `models.json`.

ACP is preferred when the selected agent has a maintained ACP implementation
and passes PocketCoder's conformance requirements. PTY remains the supported
fallback. AgentAPI's experimental ACP adapter is useful, but its current HTTP
projection and state behavior are not yet a complete durable structured
transport for PocketCoder.

## Why no new transport

Each examined integration can deliver text, stream progress, report tools,
and be cancelled. Adding another wire protocol would therefore not solve the
hard problem. The missing common contract is durable identity and replay:
PocketCoder must be able to reconnect after a process or workspace restart,
identify every completed message and tool result exactly once, and rebuild the
same transcript without parsing a terminal UI.

Pi's JSONL RPC is capable, but it is agent-specific. It informs the
requirements below rather than becoming a PocketCoder protocol. ACP is the
best shared direction, but ACP v1 message chunks do not carry a standard
stable message ID. AgentAPI's ACP mode also documents that ACP state
persistence is unsupported. Adopting either as a new durable transport today
would require PocketCoder-owned correlation and persistence semantics—the
very custom adapter surface this decision avoids.

## Capability comparison

This comparison uses the versions pinned in the repository where available:
Pi `0.83.0`, OpenCode `1.0.98`, Codex CLI `0.134.0`, and AgentAPI `0.12.2`.
Claude is evaluated against the current official Agent SDK documentation.
“Partial” means the capability exists but its adapter-specific behavior or
durability still needs conformance proof.

| Capability | Pi JSONL RPC | OpenCode ACP | Codex app-server | Claude Agent SDK |
|---|---|---|---|---|
| Complete messages | Supported | Supported | Supported | Supported |
| Streaming text and tool progress | Supported | Supported | Supported | Supported |
| Tool calls and results | Supported | Supported | Supported | Supported |
| Images or richer input | Images | Partial: ACP supports rich content; adapter must be tested | Partial: image and image-URL input; generic file semantics differ | Images |
| Cancellation and process exit | `abort` plus host exit | ACP cancel plus host exit | Turn interrupt plus host exit | Interrupt/abort plus host exit |
| Session restore or resume | Session files, switch, fork, clone | Partial: negotiate and test ACP session capabilities | Thread resume and fork | Session resume and fork |
| Stable message identity for replay | Partial: durable entry IDs, but live general events lack message IDs | Gap: ACP v1 chunks have no standard message ID | Stable thread, turn, and item IDs | Stable message and session IDs |
| Structured errors and stop reasons | Supported | Partial: JSON-RPC/ACP plus adapter mapping | Typed errors and retry state | Typed result/error subtypes and stop reasons |
| Maintained integration owner | Pi package owner | OpenCode's official ACP server | Official, experimental Codex app-server | Official Anthropic SDK |

Codex evidence comes from `codex app-server --help` and JSON schemas generated
by `codex app-server generate-json-schema --experimental` from the pinned
binary. Those schemas include thread resume/fork, turn interrupt, item IDs,
message deltas, image inputs, and typed error notifications.

## Requirements before reconsidering

A proposal for another transport must provide all of the following:

1. A transport-neutral durable model for stable message IDs, complete replay,
   tool calls/results, text/images/resources, turn state, stop reasons, and
   typed errors.
2. Conformance results for the repository's supported Pi, OpenCode, Codex, and
   Claude integrations, using maintained adapters and pinned versions.
3. An automated reconnect test that resumes after both agent-process restart
   and workspace restore without lost, duplicated, or reordered messages.
4. A named upstream owner and explicit version/upgrade policy for every
   adapter on which the transport relies.
5. No new long-lived credential visible to the workspace. Gateway credentials
   must remain workspace-scoped and expire with the workspace.

Until these conditions are met, adding a third transport would increase the
maintenance and security surface without giving PocketCoder a reliable common
conversation contract.

## Primary references

- [Agent Client Protocol TypeScript SDK: client-side connection](https://agentclientprotocol.github.io/typescript-sdk/classes/ClientSideConnection.html)
- [ACP message-ID proposal and current limitation](https://agentclientprotocol.com/rfds/message-id)
- [OpenCode ACP server](https://dev.opencode.ai/docs/acp/)
- [AgentAPI repository and protocol boundary](https://github.com/coder/agentapi/tree/v0.12.2)
- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Claude Agent SDK streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- Pinned Pi RPC reference: `examples/harnesses/pi/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
