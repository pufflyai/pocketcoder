# Durable preview grants

The consumer decides who may view a website. PocketCoder enforces an opaque
subject and access revision supplied by that consumer. It never interprets
application roles. Keep the backend machine key outside the workspace and browser.

All routes below are under `/v1/workspaces/{id}/preview-grants` and require
`previews:open`, current key authority and workspace ownership.

| Operation | Input and behavior |
| --- | --- |
| `POST /` | `id` (stable UUID), `subject`, `accessRevision`, exact `previews` names, and absolute `ceilingAt`; 201 created or 200 identical replay |
| `GET /{grantId}` | Durable identity, lease/ceiling/ revocation times and local `pendingStreams` |
| `POST /{grantId}/renew` | Same `accessRevision`; extends the lease within its original ceiling |
| `POST /{grantId}/revoke` | Durable revoke, then stream closure; 200 completed or 202 with pending closure count |

Each grant is bound to one principal, issuing key, workspace and incarnation.
Creation rejects a ceiling beyond workspace or key authority. Initial expiry is
at most 60 seconds. Renewal cannot change subject, scope, access revision,
incarnation or ceiling. Expired and revoked IDs cannot revive. To change authority,
revoke and create a new ID. Concurrent renew/revoke writes serialize in the store.

Pass `grantId` to `POST /v1/workspaces/{id}/previews/{name}` with the existing
`session.mode` of `top_level` or `embedded`. The SDK's `previews.open` takes the
same option. The one-use exchange token, cookie, isolated origin and live streams
all stay bound to this grant. Exchange never extends its lease. Renewal requires a
fresh open/exchange for a browser to use the longer lease; old cookies retain
their earlier bound. Local loopback preview mode retains its existing behavior.

Revocation commits before closure. A 202 response means tracked streams still need
to close; poll the grant's `pendingStreams` before treating local closure as done.
Active HTTP bodies and WebSockets check durable authority every 250 ms. Direct
local revocation also signals them immediately. A separate expiry timer bounds
access even when authority reads or the consumer backend stall. Reads and messages
do not renew grants or workspace lifetime. Tests measure closure after delayed
store revocation and expiry, including a stalled HTTP body, while another subject
on the same backend key keeps access.

Grant and revocation records survive controller restart. Browser token/cookie
exchange state is local to the controller, so restart needs a fresh open. Restored
or replaced workspaces need fresh grants and origins. Old cookies and tokens never
retarget a new incarnation. Session-facing preview resolution belongs to PC-139;
this physical API does not perform successor-workspace lookup.
