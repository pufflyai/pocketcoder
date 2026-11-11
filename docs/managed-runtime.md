# Managed sessions and capacity budgets

PocketCoder stores logical sessions, immutable execution profiles and budget
policies for physical capacity. A session can exist without
compute. Its ID is also its canonical conversation ID. The existing conversation
owner creates transcript records on the first turn; this adds no second transcript.

Logical request acceptance/dispatch, session file APIs and physical capacity
accounting extend these same owners. See [session work](managed-session-work.md).
Creating a profile does not launch compute. Placement and replacement, cancel and
close, and history replay are described in [session work](managed-session-work.md).
PocketCoder does not manage model usage. Model access, model choice, token limits
and model spend belong to the deployment's model gateway; reference deployments use
[agentgateway](https://agentgateway.dev/). See [security](security.md#model-access-is-a-gateway-concern).
The implemented operations are marked `x-shipped: true` in the
[versioned contract](managed-contracts.md). The running server's `/v1/openapi.json`
describes the installed routes and standard error envelopes.

## Provision authority

An owner key with `admin` provisions authority outside every workspace:

1. `PUT /v1/budget-scopes/{scopeId}/grant` with `principalId` and `installation`.
   Register exactly one installation scope per controller and grant it to every
   execution principal. Additional opaque scopes may have several principal grants.
2. Write each scope policy through `PUT /v1/budget-scopes/{scopeId}/policy`.
   The first write needs `If-None-Match: *` and revision 1. Updates need
   `If-Match: "<current revision>"` and the next revision. An identical retry returns
   its committed revision. A different payload conflicts. The server sets
   `effectiveAt`; callers cannot backdate it. Responses include an ETag.
3. For business credentials, register the existing trusted runtime issuer through
   `PUT /v1/credential-bindings/{bindingId}`. Include the target `principalId`,
   trusted `secretName`, declared `slots`, and finite
   `authorityExpiresAt`. The server pins its current issuer version; an owner may
   supply a known `secretVersionId` explicitly. Identical retries retain the
   original version. The issuer configuration and its authentication stay in
   the encrypted control-plane vault. No issuer URL or standing bearer belongs
   in a session, template, prompt or workspace.
4. `PUT /v1/execution-profiles/{profileId}/revisions/{revision}?principalId=...`
   with an `ExecutionProfile`. Its complete budget scope set must include the
   installation scope. Its template digest, isolation scope and optional
   credential binding become immutable. Publish a new revision to change them.

Only an owner can register grants, bindings and profiles. Policy writes require
`budgets:admin` and ownership of a personal scope with one grantee, or owner
authority. Installation scopes and scopes shared by several principals require
owner `admin` authority for every policy write, including identical replay. Reads require
`budgets:read` and a scope grant, or owner authority. Execution keys cannot give
themselves grants or remove a profile's scopes.

## Create and look up a session

`POST /v1/sessions` accepts `sessionId`, `profileId` and `profileRevision` and needs
`sessions:write`. `GET /v1/sessions/{sessionId}` needs `sessions:read`. Both recheck
current key, principal, template and profile authority. Foreign identities return
no metadata. Retrying creation after a lost response returns the same session;
changing its profile conflicts. New sessions report `provisioning` without claiming
producer readiness. Closed sessions retain their creation identity.

The internal binding port uses a revision comparison and monotonically increasing
generation. It checks actual workspace ownership, template, incarnation, lifetime
and required policies. Detaching or replacing compute requires the old workspace
to have ended and every old lease to be revoked or recorded expired. A revocation
outage keeps that operation pending. Clearing a binding never resets its generation.
Observations follow the versioned session transition table. A failed session can
close or return to provisioning through a fresh binding. A fenced replacement
may also move a ready session back to provisioning; a suspended session must
provision before it can become ready again.

A session with business credentials gets its own workspace unless its profile
sets `credentialPlacement: "shared"`. Then sessions of that same profile revision
share a workspace: same principal, binding, isolation and scopes. Credential-free
sessions share under the same rule. Every shared workspace also needs installed
parallel-conversation, lookup, deduplicated-accept and targeted-cancel
capabilities. The placement owner joins the fullest live workspace with room
under `maxChatProcessesPerWorkspace`; otherwise it launches a new one within
budget, or waits. There is one trust zone inside shared compute: siblings can
read each other's leases. See [security](security.md).

Each bound credentialed session gets its own lease for every template credential
slot, at `/run/pocketcoder/secrets/leases/sessions/<session>/<slot>`. A Pi turn
sees only its own session's paths. The session becomes ready once they are
installed. Closing a session on shared compute revokes only its leases and stops
only its process; the last session to leave stops the workspace. A session lease
that expires is removed on its own; the workspace keeps running. Session leases
need supervisor protocol 15.

Lease requests bind session, profile, physical incarnation, generation, slot and
broker version. Only slots declared by the pinned template/profile may be used.
Renewal keeps that broker version and authority ceiling. Expiry is capped by the
workspace deadline, delegated ceiling and existing five-minute lease maximum.
A successor receives fresh lease IDs; stale generations cannot issue or renew.

## Capacity budgets

A budget policy limits physical capacity for one scope: workspace starts per UTC
day or month, active physical workspaces, and agent processes per workspace. A
request runs only when every scope of its profile allows it. Model calls are not
counted here.

`GET /v1/budget-scopes/{scopeId}/usage` returns the policy revision, the current
period, workspace starts in that period, active workspaces and the server `asOf`.
A durable clock floor stops a backward wall-clock move from reopening a past
period.

Workspace starts and active physical workspaces come from durable managed
capacity reservations. Shared sessions consume one physical slot and
separate process slots; credentialed sessions are exclusive unless their profile
opts in to sharing. Launch admission
reserves start allowance before storage preparation and charges it immediately
before provider submission. Proved non-submission is audited without a start charge.
Only generation-bound process-stop or provider-fencing evidence releases capacity.
Changing the period of a scope with recorded starts requires audited handover;
lowering or raising limits never rewrites earlier charges.

## Validation limits

Real isolated PGlite and PostgreSQL fixtures exercise these store and HTTP owners.
The HTTPS issuer fixture covers lost replies, exact authority, pinned renewal,
exclusive placement and revoke outages without paid provider credentials.
These checks do not qualify a full Docker/Kubernetes managed-agent deployment.
PC-140 and PC-62 retain those release gates.

Capacity usage reads every capacity record under scope locks. Its work grows with
the number of managed workspaces; no performance or concurrency limit is raised here.
