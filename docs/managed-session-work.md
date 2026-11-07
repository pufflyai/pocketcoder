# Session requests and retained files

The session API accepts work without exposing workspace IDs, adapter digests or
physical fingerprints to applications. Sessions are optional: standalone finite
processes still use the workspace execution API without an agent or conversation.

Creating a session does not launch compute. Requests can queue while compute is
absent. A trusted placement owner binds an owned runtime through the internal
session port. Automatic placement and replacement are the later PC-171 slice;
SDK/CLI clients are PC-139.

## Configure bounded queues and storage

Set `POCKETCODER_SESSION_QUEUE` to a JSON object with positive integer `count`
and `bytes` limits per session. There is no production default. Bytes include
the exact encoded request body. The count and byte charges stay held through
execution, collection and the applicable cleanup barrier.

For example, a local test deployment can use `{"count":8,"bytes":1048576}`.
These are fixture bounds. Configure immutable input storage separately through
`POCKETCODER_INPUT_STORAGE`; its file, staged byte, transfer, retention,
principal and instance bounds still apply.

## Public operations

Every route checks the current key, principal, session, profile and template
authority. Writes require `sessions:write`; reads require `sessions:read`.
Controller keys stay outside workspace-readable files.

| Route | Behavior |
| --- | --- |
| `POST /v1/sessions/{sessionId}/requests` | Accept or replay a logical request |
| `GET /v1/sessions/{sessionId}/requests/{requestId}` | Observe its durable state and explicit outcome |
| `POST /v1/sessions/{sessionId}/inputs` | Register immutable input metadata |
| `PUT /v1/sessions/{sessionId}/inputs/{inputId}/content` | Upload exact bytes and verify length and digest |
| `GET /v1/sessions/{sessionId}/inputs/{inputId}` | Read the immutable reference and readiness |
| `GET /v1/sessions/{sessionId}/requests/{requestId}/collection` | Read a collection receipt, including pending or empty results |
| `GET /v1/sessions/{sessionId}/exports?requestId={requestId}` | List one request's retained objects and current availability |
| `GET /v1/sessions/{sessionId}/exports/{exportId}/content` | Read retained bytes without live compute |

These operations return 200 for a successful create, acceptance or replay.
Inspect the resource state: an empty object list does not prove collection
completed. Pending, successful empty, partial and lost collections remain distinct.
Unavailable or expired content returns 404 while its receipt remains readable.

Applications persist a request UUID and resend the exact message, ordered file
references and absolute `dispatchDeadline` after a lost reply. Changed content,
file order or deadline conflicts. Replay returns the same turn identity before
checking new queue charges or revalidating expired input bytes.

The deadline limits unstarted work. It is checked at materialization and before
each permitted send, including a resend after the original producer proves absence.
It does not end work already running. A producer that reports absence after
observed execution leaves `checking_outcome`; that contradiction cannot authorize
another dispatch.

## File and request ownership

Session registration maps to the existing immutable input owner. Canonical bytes
live in a session storage namespace; physical projections are disposable copies.
New requests reject expired or unavailable inputs. An already accepted request
keeps its exact pinned versions until finalization and can project them into a
replacement workspace without another upload.

The existing `conversation_requests` row stores the logical fingerprint, queue
sequence, turn ID, physical envelope and collection mapping. Public request IDs
are session-scoped. The internal physical request ID is the server turn ID, so
two shared sessions may use the same public request UUID without colliding.
Managed workspaces reject new legacy execution submissions.

One request per session progresses past the finalization barrier. Qualified
parallel sessions can progress independently. An envelope that was never sent
can be retired after runtime fencing while retaining its logical identity and
physical attempt evidence. A possibly sent request is not blindly replayed.
Runtime loss settles explicit lost/partial evidence, preserves any observed
terminal result, and retains queue charges until required cleanup is proved.

Logical files and result references survive physical workspace purge. Their own
retention still applies. Transcript deletion removes completed request text and
keeps content-free identity receipts; artifact retention remains separate.
Cancellation, close and retained history/event replay are the later PC-172/173
owners.

## Adapter result publication

Service operations with output roots require observed `explicit-publication`
support from both the installed runtime and adapter. A manifest declaration alone
does not qualify them.

An accept, lookup or cancel observation can include `publication` with a
`complete` boolean and `objects`. Each object supplies a stable
`publicationId`, logical name, media type, byte count, SHA-256 digest and
`contentBase64`. The declared relay response byte limit also bounds this reply;
base64 and envelope bytes count toward that limit.

The controller verifies and stores immutable bytes before accepting terminal
facts. Duplicate publication IDs replay only with identical descriptors and
bytes. The terminal transaction selects exact stored objects and commits one
manifest before producer acknowledgment. Later writes cannot change those bytes.
Retention begins at manifest publication; a sweep cannot expire an unfinished
operation's staged publications.

An explicit complete publication with zero objects produces a successful empty
manifest. Cancellation or loss before complete publication keeps already frozen
objects and reports partial/lost evidence. A lost acknowledgment retries the
same acknowledgment without repeating execution.
