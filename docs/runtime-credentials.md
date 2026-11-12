# Runtime credentials

The controller holds issuer authentication. Workspaces receive only scoped
credentials that expire no later than the workspace, and within five minutes.
The controller stores lease metadata and acknowledgements, never credential bytes.

## Managed issuer configuration

A principal's `issuers` map declares `url`, `tokenFile`, optional `policy`, and
`revoke` (false by default). Its profiles name an issuer from that same map.
The controller reads the mounted token file before every call. Rotate the file
and briefly accept both tokens at the issuer; chats need no profile update.
Managed issuers do not use the encrypted vault or `POCKETCODER_SECRET_KEY`.

URLs must use HTTPS. A plain HTTP URL must end in `.svc.cluster.local`, and the
controller must set `POCKETCODER_CLUSTER_LOCAL_ISSUERS=true`. Redirects are refused.
The token file stays in the controller's namespace and outside workspace mounts.

## Mint

The controller sends a bearer-authenticated JSON POST:

```json
{
  "operation": "mint",
  "request_id": "a fresh UUID",
  "session_id": "the chat UUID",
  "generation": 3,
  "profile": "chat",
  "owner": "user-123",
  "group": "client-456",
  "slot": "business-api",
  "expires_at": "an ISO timestamp within five minutes",
  "policy": {}
}
```

Reply with `{ "credential": "...", "expires_at": "..." }`. The credential is at
most 32 KiB, contains no NUL, and expires after now and no later than requested.
No identity echo, lease ID, digest or deterministic signing is required. Every
retry, reconnect and unacknowledged delivery mints with a new request ID. The
issuer may return different bytes every time. A reply for a closed session,
ended workspace or old generation is dropped.

`403 {"refused":true}` means the user no longer has access. Queued requests fail
with `credentials_refused`; a running turn ends when its credential expires.
A new request asks again. A bare 403, another non-success reply, timeout or invalid
reply means unavailable and is retried. Error bodies and credentials never
appear in public errors or logs.

## Delivery and renewal

Each session slot lives under
`/run/pocketcoder/secrets/leases/sessions/<session>/<slot>`. The supervisor installs
at most one value at a path and acknowledges it. Credentialed dispatch requires
those acknowledgements. Renewal starts halfway through the credential lifetime.
The previous value stays installed until replacement succeeds, then expires at
the resource on its own.

A superseded delivery is excluded from future delivery selection. Its generation
cleanup obligation remains until removal, workspace end or expiry is recorded.
A lost response cannot make the controller forget authority that might exist.

## End of a generation

When `revoke: true`, close and replacement also send
`{ "operation": "revoke", "session_id": "...", "generation": 3 }`.
A 200 reply acknowledges that every credential through that generation is no
longer needed. The controller retries failures and records the acknowledgement.
The issuer needs no per-credential registry; the resource can revoke by chat and
generation. Late mint replies still never reach a workspace.

Without revoke, resource access can last until expiry, at most five minutes.
Close and replacement wait for supervisor removal acknowledgement or the end of
the workspace. With revoke, they also wait for its acknowledgement. One session's
cleanup on shared compute leaves its siblings' credentials alone.

## Plain workspaces and setup

Setup and plain runtime issuers remain vault entries administered through the
secret API. Registry credentials remain vault entries too. These deployments
need the controller's vault encryption key. Setup and plain runtime minting use
the same slim reply and fresh request IDs; their session identity is the workspace
ID. Setup completion revokes the generation before acknowledging completion.
No vault key or issuer authentication enters a workspace.

Plain workspace issuers use the same slim callback. Setup uses generation `1`; runtime uses generation `2`. Completing setup revokes only setup authority. Normal runtime renewal lets the old credential expire without a generation revoke. Workspace teardown revokes the runtime generation.
