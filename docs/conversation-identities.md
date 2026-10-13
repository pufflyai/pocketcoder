# Conversation identity protocol

The `pocketcoder.conversation/v2` envelope preserves identities supplied by a
caller. PocketCoder does not allocate turns or infer identities from old messages.

## Authority and acceptance

Use `authority: external` when another service owns request acceptance. Onefin
allocates its turn UUID and fingerprints the normalized message plus the accepted
immutable manifest. PocketCoder stores a receipt of that decision; this receipt
is not a second Onefin turn ledger and does not dispatch a prompt.

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
increments the revision rather than creating another turn. Stored events are
scoped by logical conversation, turn, event, and revision, so reused provider IDs
in a later turn remain distinct. `identity.message_id` is the caller's message
identity; the outer history `message_id` is the storage deduplication key.

Receipts are durable in PostgreSQL and shared by resumed workspace generations.
The in-memory adapter provides the same reconciliation contract while its process
is alive. Accepted contexts remain independent of transcript retention, so
removing message content does not make a previous request acceptable again.

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

```text
GET    /v1/workspaces/{id}/conversation   scope conversations:read    query: cursor (opaque), limit (max 200)
DELETE /v1/workspaces/{id}/conversation   scope conversations:delete  idempotent
```

The transcript is append-only durable data and remains available after the
workspace becomes terminal. It does not use the live relay. Each item has a
PocketCoder sequence, harness-stable `message_id`, `role` (`user`,
`assistant`, `system`, or `tool`), bounded text `content`, `occurred_at`, and
bounded redacted string metadata. Responses include `next_cursor` and the
retention deadline. Each workspace is capped at 100,000 messages and 50 MiB
of canonical content/metadata; each message is capped at 256 KiB.

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

