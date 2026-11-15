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

### Publish a generated file

Native Pi sessions can explicitly select a completed file with the installed command:

```sh
pocketcoder-supervisor session publish-file \
  --file /workspace/report.csv --name report.csv --media-type text/csv
```

The template must declare `message.outputRoots` covering the file and the installed
runtime and adapter must support `explicit-publication`. The native Pi template
declares `/workspace`. Templates with no output roots keep publication disabled.
The command is available only inside its running request; it needs no controller key.

The command returns metadata with `state: "staged"`. PocketCoder snapshots the bytes
into the request journal and transfers them through the existing execution channel.
A file becomes downloadable only after the controller retains it and settles its
collection. File bytes never enter conversation parts or the command's output.
Changed source files cannot change the retained version. Only explicitly selected
regular files are read; links, traversal, special files and cross-filesystem reads fail.

Repeating the same path, name and media type in one request uses the same publication
ID. Changed bytes under that identity conflict. Use `--id <new-uuid>` for an intentional
revision, and reuse that ID when retrying after a lost response. Separate requests
have separate publication identities. Filenames may repeat without replacing an
earlier request's output.

Native publication is bounded by the template's `exportBytes` and `exportFiles`,
with an initial ceiling of **2 MiB total and 100 files per request**. Lower relay
response limits reduce the byte allowance. Use 8 MiB buffered response limits on
all four execution routes for the full allowance. Publication-enabled requests reserve
a 3 MiB transcript budget and room for the final outcome, file metadata and both
base64 transport envelopes within the control frame limit.
The limit applies before reading the file. Larger-file streaming is not part of
this transport; increasing template limits alone does not enable it.

Completed requests seal an explicit complete publication, including zero files.
Cancellation or runtime loss keeps selected files as partial evidence when the
controller has received them. A workspace lost before transfer cannot promise a
download. The collection receipt remains the authority for readiness and availability.

### Download retained results

Read `GET /v1/sessions/{id}/requests/{rid}/collection` and
`GET /v1/sessions/{id}/exports?requestId={rid}` for the retained filename, media type,
byte count, SHA-256, expiry and availability. Download a selected object with
`GET /v1/sessions/{id}/exports/{exportId}/content`. These operations require current
`sessions:read` authority for that session, even if the caller already knows the ID.
The SDK exposes `client.requests.collection`, `client.files.exports` and
`client.files.content` for the same flow.

Keep session and request IDs in the consumer; no workspace path or permanent storage
URL is needed. Results remain readable after close, compute replacement and physical
workspace content purge. Runtime result retention still applies, and expired or
deleted bytes return 404. Reading or retrying a download never starts compute.
Consumers can restore file cards from the collection without replaying conversation
text. They remain responsible for their own business authorization and download UI.

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
