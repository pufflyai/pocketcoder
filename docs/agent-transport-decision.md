# Native structured sessions

Accepted on 2026-11-10. This replaces the terminal bridge.

PocketCoder owns the public session format. Producers send structured messages. Clients render them. A client never repairs terminal output or extracts records from text.

## Producer contract

The bundled echo and Pi producers implement `pocketcoder.execution/v1`. A service exposes the template-declared `accept`, `lookup`, `cancel`, and `ack` endpoints under `/executions/`.

Both workspace requests and managed requests send `input.message`. The controller supplies the accepted conversation identity and immutable input directory. Files in that directory use file IDs as their names. The original filenames are metadata.

Observations carry canonical messages with stable message IDs, event IDs, sequence numbers, and revisions. Message parts describe:

- Text, including markdown and Unicode.
- Tool calls, with call ID, name, status, input, and output.
- Errors, with a code and readable message.
- Files, with their IDs and metadata.

The controller ingests these messages before recording a terminal execution observation or acknowledging the producer. A completed record therefore retains the same parts that clients saw live.

A final response is an explicit producer fact. Earlier narration is not promoted to a final response when a turn only used tools or failed.

## Replay and cancellation

The native producer keeps atomic request snapshots. Lookup and a repeated accept return the same IDs and revisions. An accepted request is never executed again after a producer restart. An unfinished request from a dead producer ends as lost.

Cancellation names one execution and its fingerprint. Canceling before accept creates a durable tombstone, so a late accept cannot start the work. The producer stops the operation and its tool process group before acknowledging cancellation.

The native producer bounds tool payloads and total observation size. A limit failure produces a valid failed record. It does not leave a malformed journal that cannot be replayed.

## Client contract

The SDK exposes `workspaceRequests.submit/get/list/cancel` and `conversations.read/open/live`. Managed clients use `requests` and `sessions.history/open/events`.

`open` returns snapshots of turns in progress. These snapshots live in controller memory. Retained history and managed lifecycle events provide durable replay. After reconnect, clients reload retained history and the current open turn, then reconcile by message ID and revision.

The CLI, PocketCoder Lab, and the Workspaces extension consume these contracts. Their message views map canonical parts to their UI types. They do not interpret text as an event protocol.

## Pi and Onefin

Pi uses its native JSON RPC protocol. The adapter consumes text deltas, tool events, message stop reasons, and `agent_settled`. It waits for retries to finish before reporting an outcome. See the [pinned Pi RPC reference](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/rpc.md).

The Onefin example redeems one-use launch input, refreshes the workspace-scoped credential through a private Unix socket, and runs the same native Pi producer. Model authority stays on the host. See [security](security.md).

## Images and templates

Native services use `pocketcoder.dev/v1` templates. The image supplies `/opt/pocketcoder/workload.json`, with measured runtime and adapter artifacts, commands, and capabilities. Templates pin those digests. The driver checks the installed bytes and storage boundary before readiness.

Persist the directory named by `POCKETCODER_SESSION_DIRECTORY` when a template supports conversation restore. Its image-owned checkpoint hook fences the producer before capture.

The removed `spec.agent` format and terminal message routes are unsupported. Publish a native service template and use canonical conversation data. Other agent integrations can implement the same producer contract or use the Prompt Studio relay connection.
