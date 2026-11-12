# Connect a consumer

A consumer needs one principals-file entry, one issuer endpoint if its agent
needs business credentials, and seven API calls. Its backend keeps chat and
request IDs. PocketCoder owns profiles, limits, placement, credential delivery,
replay, cancel/close, memory and the conversation feed.

## Controller configuration

Mount this file only into the controller and set `POCKETCODER_PRINCIPALS_FILE`:

```json
{
  "principals": [{
    "name": "onefin-backend",
    "scopes": ["sessions:read", "sessions:write"],
    "templates": ["onefin-agent"],
    "key": { "target": { "kind": "file", "path": "/run/backend-key/token" } },
    "issuers": {
      "onefin": {
        "url": "https://backend.example/internal/agent-issuer",
        "tokenFile": "/etc/pocketcoder/issuers/onefin/token",
        "revoke": false
      }
    },
    "profiles": {
      "chat": {
        "template": "onefin-agent",
        "issuer": "onefin",
        "placement": "shared",
        "limits": { "workspacesPerOwner": 1, "sessionsPerWorkspace": 5 },
        "dispatchDeadlineSeconds": 600
      }
    }
  }]
}
```

The backend reads the controller-written key file. Workspaces cannot mount it.
For Kubernetes, use a `kubernetes-secret` key target. Create the empty Secret in
the backend namespace first. Grant the controller service account `get` and
`patch` on that Secret name only; it needs no namespace-wide create permission.
Mount the issuer token separately in the controller's own namespace.

Publish `onefin-agent` through the template API with operator authority. The
profile follows its active release. To roll back, add a `templateVersion` pin.
Use `pcd principals plan`, then `pcd principals reconcile` for an immediate file
update, or let the five-minute reconciliation pass apply it. A ConfigMap change
must not restart the controller merely to reload profiles.

## Stateless issuer

Check the controller bearer and authorize `session_id` against the consumer's
own chat record, user and group. Reply with a short-lived credential scoped to
that chat, user and business permissions, bounded by the requested expiry.
Return `403 {"refused":true}` when access is denied. The credential can include
`generation`, letting a gateway reject an old placement.

Do not store request IDs or credentials to reproduce old replies. PocketCoder
always mints fresh. Rotation changes the mounted token file; accept the old and
new controller bearer briefly during rollout. When immediate business cutoff is
needed, the resource rejects credentials for a closed chat. Alternatively, enable
session-wide generation revoke. See [the protocol](runtime-credentials.md).

## Seven calls

| Job | HTTP call | SDK |
| --- | --- | --- |
| Open a chat | `POST /v1/sessions` | `client.sessions.create({sessionId, profile: "chat", owner, group})` |
| List a user's chats | `GET /v1/sessions?owner=&state=open` | `client.sessions.list({owner, state: "open"})` |
| Attach a file | `PUT /v1/sessions/{id}/inputs/{inputId}` | `client.sessions.upload(id, file)` |
| Send | `POST /v1/sessions/{id}/requests` | `client.requests.submit(id, {requestId, message, attachments})` |
| Read changes | `GET /v1/sessions/{id}/conversation?after=` | `client.sessions.conversation(id, {after})` |
| Stop work | `POST /v1/sessions/{id}/cancel` | `client.sessions.cancel(id)` |
| Close | `POST /v1/sessions/{id}/close` | `client.sessions.close(id)` |

A profile health check uses `client.profiles.get("chat")`. The consumer authorizes
every call before passing its session ID to PocketCoder. Owners and groups are
opaque IDs from those authorized records, never unchecked browser values.

Create session and request IDs before sending. Retry a lost reply with the same
message and attachment IDs. A browser outbox may retain unsent messages; the
backend needs no provisioning mirror, request-body store, deadline, profile
revision, lease record or owner key.

Merge feed changes by message/request ID. Clear the view when `reset` is true.
A chat placed on fresh compute keeps its earlier context through the history
seed. The consumer does not copy agent files or wait for the first workspace.

## Attribute agent work

The agent process sees `POCKETCODER_TURN_ID`. A tool can send it in a header such
as `X-Onefin-Turn`. The consumer chooses the chat from the credential, then
checks that the feed lists this turn for that chat before displaying work under
it. If it does not, display the work at chat level. The turn ID is a display hint;
shared-workspace siblings can read one another's files and environment.

The [reference consumer](../examples/clients/managed-runtime/consumer.ts) uses
only the public SDK. Onefin's separate repository must adopt this contract in
its own rollout; PocketCoder does not change its business authorization or model
spend controls.

Run `bun --no-env-file examples/e2e/kubernetes-managed-sessions.ts` to qualify the managed API on an owned Kind cluster. It runs five parallel chats on one workspace, drains idle compute for another group, and checks close cleanup. The fixture deletes its own cluster and images after the run.
