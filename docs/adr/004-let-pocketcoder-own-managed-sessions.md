# ADR: PocketCoder owns managed sessions; the consumer only authorizes

Status: Accepted (PC-186)

## Context

In 0.13 and 0.14, PocketCoder made managed authority immutable: profile revisions, credential
bindings with a pinned issuer version and a fixed expiry, and budget policies with revisions
and periods. No recorded failure motivates these rules (the PC-186 research). They also
push generic work onto every consumer. Onefin's first integration spends about 60% of its code
on provisioning mirrors, a stateful issuer, replay storage, a conversation merge and a
running-turn lookup. The Lab rebuilds the same pieces.

The consumer's issuer already decides on every mint, at least every 2.5 minutes while a session
has a workspace, whether the user may still act. PocketCoder's own job is to deliver that
decision safely: to the right session and generation, never to a replaced or closed one.

## Decision

- **PocketCoder does all generic session work.** That covers:
  - profiles, limits and template versions;
  - placement, sharing and making room;
  - the credential lifecycle and lease state;
  - agent memory across workspaces;
  - replay, cancel and close;
  - the conversation feed and turn identity.

  A consumer writes configuration, one stateless issuer endpoint and seven API calls
  ([integration](../managed-consumers.md)).
- **The consumer's issuer is the only authority over credentials.** PocketCoder keeps no
  long-lived authority of its own. Every mint uses the current issuer settings, and the issuer
  answers yes (a credential) or no (`403 {"refused": true}`).
- **PocketCoder never asks the issuer to reproduce a credential.** Replays, unacknowledged
  deliveries and retries all mint fresh. A late reply for a closed or replaced generation is
  dropped. So the issuer is stateless, and revoke is an optional, session-wide notice.
- **Delivery safety stays in PocketCoder**: generation and incarnation fencing, per-session
  leases with install acknowledgement, exact request replay, and `generation` in each mint so
  a consumer can refuse a replaced workspace.
- **Profiles and issuers are operator configuration** in the principals file, re-applied on
  each reconcile pass without a restart.
- **A new workspace's agent starts from the stored conversation**, not from a copy of the
  harness's own state file. It loses raw tool outputs, but it works across template versions
  and needs no new storage.

## Consequences

- A chat lives as long as the consumer allows.
- A template release or rollback needs no consumer code.
- Token rotation needs one thing from the consumer: accepting the old and new token for a few
  minutes.
- Without `revoke`, a credential stays valid at the consumer's resource for at most five
  minutes after its session ends. Consumers that need immediate cutoff enforce it at the
  resource, or turn `revoke` on.
- A key with only `secrets:write` cannot affect managed sessions. Changing issuers or profiles
  needs control of the controller's configuration.
- The managed API breaks once (0.15.0). Managed data is recreated; no deployment holds managed
  data yet.
