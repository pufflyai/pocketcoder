# Conversation identity protocol

The `pocketcoder.conversation/v2` envelope preserves identities supplied by a
caller. PocketCoder does not allocate turns or infer identities from old messages.

## Authority and acceptance

Use `authority: external` when another service owns request acceptance. That
service allocates its turn UUID and fingerprints the normalized message plus the accepted
immutable manifest. PocketCoder stores a receipt of that decision; this receipt
is not a second turn ledger for the caller and does not dispatch a prompt.

Use `authority: generic` when a generic PocketCoder caller owns those identities.
Both modes require caller-supplied UUIDs for `conversation_id`, `request_id`, and
`turn_id`, plus a lowercase SHA-256 `request_fingerprint`. The logical conversation
ID survives workspace resume; it is not the physical workspace generation ID.

Register the context with `POST /v1/workspaces/:id/conversation/requests`, or
`client.conversations.acceptRequest(id, identity)`. The route requires
`conversations:write` and ownership of the physical workspace. The receipt is
scoped by principal, logical conversation, and request. Concurrent retries return
one `201 accepted` and subsequent `200 replayed` receipts with the original
acceptance time. A changed fingerprint, turn, or authority returns `409
idempotency.conflict`. The same request UUID in another logical conversation or
principal is independent. Registration must precede identified message delivery.

## Messages and replay

The message envelope adds `event_id`, `message_id`, `sequence`, and `revision`.
Providers keep event and message identities stable within a turn. A content update
increments the revision rather than creating another turn. The controller keeps
the latest revision of each event of an open turn in memory and stores the turn
once, when its `turn_terminal` fact arrives, so reused provider IDs in a later
turn remain distinct. `identity.message_id` is the caller's message identity; the
outer history `message_id` is the storage deduplication key.

Receipts are durable in both stores and shared by resumed workspace generations. Accepted contexts
remain independent of transcript retention, so
removing message content does not make a previous request acceptable again.

## Explicit producer facts

A capable message identity may carry `fact`. Supported types are `intermediate`,
`final_response`, `tool_only`, `activity_started`, `activity_finished`, and
`turn_terminal`. Text remains in the message content. A final response identifies
answer text; it does not mean execution succeeded. The separate terminal outcome
is `completed`, `failed`, `interrupted`, `canceled`, or `lost`. An interrupted turn
may retain a final-response chunk. A tool-only turn has no invented answer.

Activity start/end facts retain the supplied UUID, safe label/type, and observed
ISO time. Unknown times are null. The schema never includes private reasoning,
raw command fields, credentials, percentages, or guessed duration. The producer
owns safe labels; the consumer drops undeclared fields. Facts persist inside the
existing JSON identity envelope, with the same request binding and replay scope.

The provider SSE event is `conversation_message`, with a canonical message as
its data. Provider history may contain the same canonical records; supervisor
checkpoint synchronization preserves them. Legacy AgentAPI records remain valid.

`RemoteAgentClient` is exported from `@pstdio/pocketcoder-remote/extension`.
`sendTurn(prompt, identity, { signal, attachmentIds, onEvent })`
is the explicit adapter path. Use it only with a verified v2 producer and a
previously accepted request context. It forwards that context, filters unrelated
requests, emits each event revision once, and waits for `turn_terminal`. Its
result contains `identity`, `outcome`, nullable `finalResponse`, and `toolOnly`.
A stream reconnect retains the last final response and replay filter. A stable
status or an old assistant message cannot complete this path. Cancellation and
transport failure remain errors; observed facts have already reached `onEvent`.

`send` remains the legacy adapter path for producers lacking explicit facts.
Consumer tests alone do not allow callers to enable the capable path in a release.

## Capability and existing history

The history page advertises protocol transport and persistence support under
`protocol`. Its `producer_capabilities` is `null`: schema support does not prove
that an installed harness emits identities, progress, or final-answer facts.
Consumers must obtain producer capabilities from a verified template release.

Legacy messages have `identity: null`. Older pages decode with `protocol: null`.
No UUIDs, progress facts, or final-answer classifications are invented when
importing existing history. Legacy producers can continue sending the original
message envelope. Older binaries must not consume v2 identified history until
upgraded; rolling back a producer to legacy emission does not rewrite saved IDs.

See [durable conversation validation](durable-conversation-validation.md) for
public contract, adapter, API, and SDK checks. Installed producer validation is a
separate release responsibility.

## Durable conversation history

PocketCoder owns conversation history and stores it as JSON (ADR 003). Each
conversation is one document, keyed by the caller's conversation identity under
the workspace owner, with many per workspace. A document is a list of immutable
records:

- a **turn record** for each finished turn: its request identity, the final
  revision of every message, activity summaries (including producer `action`,
  `subject` and failure `reason` codes), the final response, and the terminal
  outcome;
- a **message record** for each message that arrives without identity, in the
  document of its workspace;
- **legacy records** for history converted from releases before 1.0.

Records are written at turn boundaries, never per streamed revision, so a turn
costs one write. Totals are running values on the document, never a scan. If the
controller restarts during a turn, the request receipt without a stored record
becomes an `interrupted` turn record at startup; a turn whose workspace ends
first is recorded the same way. History is never rebuilt from harness or native
session files.

```text
GET    /v1/workspaces/{id}/conversation                         scope conversations:read    query: cursor, limit (max 200)
GET    /v1/workspaces/{id}/conversation/live                    scope conversations:read    text/event-stream
DELETE /v1/workspaces/{id}/conversation                         scope conversations:delete  idempotent
GET    /v1/workspaces/{id}/conversations                        scope conversations:read
GET    /v1/workspaces/{id}/conversations/{conversation_id}      scope conversations:read    query: cursor, limit (max 200)
GET    /v1/workspaces/{id}/conversations/{conversation_id}/live scope conversations:read    text/event-stream
DELETE /v1/workspaces/{id}/conversations/{conversation_id}      scope conversations:delete  idempotent
```

- `/conversation` pages the messages this workspace stored, across its
  conversations, in the order they were stored. `DELETE` removes every
  conversation the workspace wrote to.
- `/conversations` lists the conversations this workspace, or a workspace it was
  restored from, took part in, with status, counts and last activity.
- `/conversations/{conversation_id}` pages one document by message `seq`. A
  conversation continues under its ID after preserve, restore and resume.
  `DELETE` removes that document only.
- The `live` routes stream the turn in progress as `turn` events (the open turn
  so far) and a `committed` event when its record is stored. Read stored history
  from the cursor routes.

Each message is capped at 256 KiB. Each conversation, and each workspace's
stored records, is capped at 100,000 messages and 50 MiB.

**Retention.** The template's `persistence.conversationRetention` applies when
the last workspace that wrote to a conversation ends. Snapshots keep the value
they were launched with. A server can cap it with
`POCKETCODER_MAX_CONVERSATION_RETENTION`, or replace it with
`POCKETCODER_CONVERSATION_RETENTION` (a duration, or `until-deleted` to keep
history until a caller deletes it). A new turn makes an expired-pending
conversation active again.

AgentAPI-native workspaces capture accepted user input and earlier completed
`/messages` entries while the agent is running. The final assistant entry stays
pending until a read starts and finishes under the same stable health revision.
The numeric AgentAPI id becomes `agentapi:<id>`, and AgentAPI's
`agent` role becomes `assistant`; replay is idempotent. Legacy harness adapters
may still write one canonical line per complete message:

```text
POCKETCODER_CONVERSATION {"message_id":"provider-7","role":"assistant","content":"Done","occurred_at":"2026-08-03T08:00:00.000Z","metadata":{"provider":"agentapi"}}
```

Before cooperative Stop or shutdown, the supervisor waits for an older history
read and starts a fresh one before forwarding TERM. This shares the existing
termination grace period. A failed read is reported and physical termination
continues; a slow read cannot extend the deadline. KILL bypasses this final read.
Frames remain ordered on the control channel; a disconnected channel or forced
kill cannot guarantee delivery of the latest input.
The server saves transcript frames already received even if provider cleanup
finishes before queued writes. Deleted or purged history stays deleted.
Stop responses and terminal state do not acknowledge queued transcript writes;
an immediate history read can lag.
Checkpoint preparation also starts a fresh stable read within its deadline.

The supervisor validates and forwards the event over its ordered protocol;
replaying a message id is idempotent. Adapters must redact secrets and
provider-private tool/attachment data before emission. Expired transcripts
return `410 conversation.expired`; explicitly deleted transcripts return
`410 conversation.deleted` and cannot be appended again.

## Execution acceptance and dispatch

Registering a conversation context still does not start a turn. Explicit execution
uses `POST /v1/workspaces/{id}/executions` with `acceptance` and the same
`conversationIdentity`. A retry must match the identity frozen on that exact
execution. A receipt for another conversation cannot authorize a changed identity,
even when it shares the request ID. The existing conversation request row owns its execution
facts. A finite command uses the existing workspace process owner. There is no
second run ledger.

Acceptance freezes caller, workspace/incarnation, template and adapter digests,
operation input, the exact ordered input manifest, and the binding-set digest.
Credential-free execution requires `digestOf([])`. Credential slots remain closed
at this boundary until their binding authority is installed. Identical retries
return the original acceptance; changed facts conflict. Restore needs a new
workspace reference. Reconnecting the same supervisor changes only its connection
epoch.

The controller records dispatch intent before sending. A capable producer accepts,
looks up, observes, and acknowledges the same request ID. Its installed descriptor
must advertise lookup and deduplicated acceptance before redispatch is allowed.
Only an explicit absent reply in the same live incarnation permits another accept
of that ID and fingerprint. A weak producer's unsettled dispatch becomes `unknown`.
Runtime loss becomes `lost`; neither outcome automatically starts another attempt.
A durable terminal fact survives a lost acknowledgment response. Acknowledgment
retries use that terminal reference without submitting another operation.

Cancel names the execution, incarnation and caller-stable cancel ID. Before claim,
it settles as canceled without spawning. After claim it targets that operation.
A late cancel returns the terminal record. The next conversation request waits for
acknowledgment and the separate finalization barrier. Unknown or lost operations
keep that barrier closed. Legacy `/agent/interrupt` remains a workspace-scoped
operator action; it is never used to cancel an identified execution.

Input pins release when an undispatched request is canceled or when execution
finalization follows terminal acknowledgment. Unknown or lost work keeps its pins
until workspace purge verifies provider termination. Failed termination and a
controller restart before pin release leave purge retryable.
