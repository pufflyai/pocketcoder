# Session work

The consumer sends logical work. PocketCoder accepts it durably before placing
or dispatching a workspace. One request runs per session; different sessions may
run in parallel when the installed producer supports it.

## Calls

| Method | Path | Body |
| --- | --- | --- |
| POST | `/v1/sessions` | `{sessionId, profile, owner, group?}` |
| GET | `/v1/sessions?owner=&state=open` | None |
| POST | `/v1/sessions/{id}/resume` | None |
| POST | `/v1/sessions/{id}/requests` | `{requestId, message, attachments: [inputId]}` |
| GET | `/v1/sessions/{id}/requests/{rid}` | None |
| POST | `/v1/sessions/{id}/requests/{rid}/cancel` | None |
| POST | `/v1/sessions/{id}/cancel` | None |
| POST | `/v1/sessions/{id}/close` | None |
| PUT | `/v1/sessions/{id}/inputs/{inputId}` | File bytes |
| GET | `/v1/sessions/{id}/conversation?after=` | None |

A request ID replays only with the same message and ordered attachment IDs. The
controller chooses `dispatchDeadline` from the profile when it accepts the
request. A resend needs no stored deadline or physical execution fingerprint.
Possibly sent work is looked up; it is never blindly run again. Work proved never
sent may be placed again without changing its logical request and turn IDs.

`POCKETCODER_SESSION_QUEUE` defaults to `{"count":8,"bytes":8388608}`. Both limits
must be positive when overridden. Requests retain their outcomes after queue
space is released. Expired dispatch deadlines fail queued work without sending it.

## Files

Upload bytes once with their media type in `content-type` and name in
`Content-Disposition` (use `filename*=UTF-8''...` for Unicode names), or
`x-pocketcoder-file-name` for simple names. The caller chooses `inputId`. PocketCoder computes
size and SHA-256, verifies storage, and returns the immutable reference. The same
bytes and metadata replay; changed content conflicts. Inputs belong to the
principal and session, not its current workspace.

Only ready, retained inputs may be attached. Acceptance pins them through the
request's cleanup. Per-file, session, principal and instance storage limits still
apply. A session needs no placeholder workspace to upload a file.

Collection receipts and exports remain available after compute ends. A pending
collection, empty complete collection, partial collection and lost collection
are distinct outcomes. Use the collection and export routes for retained files.

## Cancel and close

A request cancel stops that request. Session cancel stops every queued and
running request in the chat. Close also refuses new work and releases the
session's compute. The calls need no caller-generated command ID or deadline.
Retries return the same pending or completed receipt. A request cancel during
close returns the close receipt.

Queued work ends locally. Running work gets targeted cancellation and remains
pending until terminal evidence arrives. A completed request keeps its outcome.
Close waits for terminal requests, process stop, credential removal and any
configured generation revoke. Siblings on shared compute keep running.

## Conversation feed

The feed merges committed records and live messages and deduplicates their IDs.
Messages include `messageId`, `requestId`, `turnId`, `role`, `parts`, `final` and
`occurredAt`. File parts carry the caller's input ID. Requests carry their own
state, outcome and collection receipt.

Keep the returned cursor and fetch with `after` to receive only changes. An
unchanged view has empty request and message arrays. After a controller restart,
or a cursor from a different controller instance, `reset: true` carries a full
snapshot. Replace the local view, then continue polling. Cursors are bound to the
principal and session.

`GET .../history` remains a paged export of canonical records. `GET .../events`
remains an SSE stream of durable state changes. Neither a disconnected browser
nor a missed poll cancels work.

## Agent identity

The Pi process receives `POCKETCODER_CONVERSATION_ID` and `POCKETCODER_TURN_ID`.
The turn ID matches the request and feed. It helps a consumer display agent work
under its originating turn. Authorization comes from the session credential,
and the consumer checks that the feed lists the turn for that chat.
