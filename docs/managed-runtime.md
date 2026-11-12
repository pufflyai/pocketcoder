# Managed sessions

A consumer declares profiles and issuers in the controller's principals file. Its
backend uses a key with `sessions:read` and `sessions:write`. It keeps session and
request IDs. PocketCoder owns placement, limits, credentials, replay and history.
See [consumer setup](managed-consumers.md) for a complete example.

## Profiles

`GET /v1/session-profiles/{name}` returns the caller's profile, its next template
version, limits and disabled state. Profiles have no write API. The controller
re-reads the principals file at startup and every five minutes. Use
`pcd principals plan` to preview changes, or `pcd principals reconcile` to apply
that same mounted file now. Neither operation restarts the controller.

A profile names a template and may pin `templateVersion`. Without a pin, each
placement uses the template's active version. Pinning an earlier version rolls
back future placements. Removing a profile disables new sessions; existing
sessions continue with its last settings.

Defaults are one workspace per owner, one session per workspace, exclusive
placement, and a 600-second dispatch deadline. A profile may name an issuer in
the same principal's `issuers` map. Managed issuers need no vault key.

## Sessions and placement

Create with `{sessionId, profile, owner, group?}`. The group defaults to the owner.
Creating the same identity again returns the original session. Changing its
profile, owner or group conflicts. List with `GET /v1/sessions?owner=&state=open`.
All access stays within the authenticated principal.

`workspacesPerOwner` counts across groups and template versions for one
`(principal, profile, owner)`. Shared placement joins the fullest compatible
workspace within `sessionsPerWorkspace`. Sharing requires the same principal,
profile, owner, group and template release, plus an installed producer that
reports parallel conversations, deduplicated accept, lookup and targeted cancel.

A durable reservation precedes workspace creation. Other sessions wait while a
compatible workspace launches, then join after its capabilities are known. A
restart continues the recorded placement with the same workspace ID.

When an owner has no room, PocketCoder drains an idle workspace: other template
releases first, then other groups, then least recent use. Draining blocks joins
and new turns. Running turns prevent a drain. Capacity is released only after
cleanup evidence for that workspace generation. Its sessions become suspended
and place again when they have work. A new message also moves an older live
binding to the profile's current template release once its work has finished.

The controller-wide and per-principal admission limits still apply. Managed
placements wait when the principal limit is full; they do not bypass admission.

## Memory and credentials

A session's first turn on new compute receives its canonical history when the
producer reports `history-seed`. The seed carries user text, assistant final
text and tool activity summaries. Raw tool output stays behind. The default
limit is 1 MiB (`POCKETCODER_SESSION_SEED_BYTES`); oldest messages are omitted
when needed, with `reasonCode: context_trimmed` on the request.

Each credential slot has a separate session lease and install acknowledgement.
A session dispatches credentialed work only while ready. Every delivery is a
fresh mint. Rotation reads the current issuer token file, so session age and
operator token changes do not end a chat. See [runtime credentials](runtime-credentials.md).

Shared compute is one trust zone: sibling sessions can read one another's files
and leases. Owner and group restrict placement; they do not isolate processes
inside a workspace. Model access and spend belong to the consumer's gateway.

## Upgrade

PC-186 replaces the managed API and recreates managed rows in one migration.
There is no compatibility layer for old managed profiles, scopes, policies or
credential bindings. Plain workspace APIs and their retained history are unchanged.
