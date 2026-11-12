# @pstdio/pocketcoder-sdk

## 0.10.0

### Minor Changes

- [#170](https://github.com/pufflyai/pocketcoder/pull/170) [`fa8d840`](https://github.com/pufflyai/pocketcoder/commit/fa8d8400ef7e390e75b9e04ba2548461b9913335) Thanks [@au-re](https://github.com/au-re)! - Accept a plain HTTP credential issuer on a `*.svc.cluster.local` host when the controller sets `POCKETCODER_CLUSTER_LOCAL_ISSUERS=true`.

- [#168](https://github.com/pufflyai/pocketcoder/pull/168) [`9b75a30`](https://github.com/pufflyai/pocketcoder/commit/9b75a30a7afbab571a4bbc52ec3f773682e51732) Thanks [@au-re](https://github.com/au-re)! - Run credentialed sessions of one profile in one workspace when the profile sets `credentialPlacement: "shared"`, with leases issued, renewed and revoked per session.

## 0.9.0

### Minor Changes

- [#161](https://github.com/pufflyai/pocketcoder/pull/161) [`3939585`](https://github.com/pufflyai/pocketcoder/commit/39395856b26df0eb577eba1d610de01be857b975) Thanks [@au-re](https://github.com/au-re)! - Retain per-turn results and session files, queue logical requests, and enforce managed workspace and process capacity.

- [#162](https://github.com/pufflyai/pocketcoder/pull/162) [`b8e377e`](https://github.com/pufflyai/pocketcoder/commit/b8e377e68d6bdfcf84898371ff33b3049b54e9aa) Thanks [@au-re](https://github.com/au-re)! - Manage sessions, requests, files, history, events, capacity budgets and session previews from the SDK (`client.sessions`, `client.requests`, `client.files`, `client.authority`) and the CLI (`pcd sessions`, `pcd budgets`).

- [#162](https://github.com/pufflyai/pocketcoder/pull/162) [`b8e377e`](https://github.com/pufflyai/pocketcoder/commit/b8e377e68d6bdfcf84898371ff33b3049b54e9aa) Thanks [@au-re](https://github.com/au-re)! - Cancel and close managed sessions, replay their history and events, and replace lost compute automatically.

- [#160](https://github.com/pufflyai/pocketcoder/pull/160) [`7515826`](https://github.com/pufflyai/pocketcoder/commit/751582601404243dc2409dc73d1db453326682da) Thanks [@au-re](https://github.com/au-re)! - Add durable managed sessions, immutable execution authority, conditional budget policies, atomic invocation reservations and trusted usage settlement.

- [#165](https://github.com/pufflyai/pocketcoder/pull/165) [`3f9ad71`](https://github.com/pufflyai/pocketcoder/commit/3f9ad7131bd3df5cdd2bbca1d04337b4e597b138) Thanks [@au-re](https://github.com/au-re)! - Replace AgentAPI with native structured session producers and typed workspace requests, live messages, tools, and retained history.

- [#160](https://github.com/pufflyai/pocketcoder/pull/160) [`7515826`](https://github.com/pufflyai/pocketcoder/commit/751582601404243dc2409dc73d1db453326682da) Thanks [@au-re](https://github.com/au-re)! - Add finite job exports, workspace service lifetime controls, durable preview grants, versioned managed runtime contracts, and file-aware Prompt Studio sessions.

- [#162](https://github.com/pufflyai/pocketcoder/pull/162) [`b8e377e`](https://github.com/pufflyai/pocketcoder/commit/b8e377e68d6bdfcf84898371ff33b3049b54e9aa) Thanks [@au-re](https://github.com/au-re)! - Remove model usage management: execution profiles no longer take `allowedModels`, budget policies only limit physical capacity, and token reservations and settlement are gone. The model gateway (agentgateway in reference deployments) owns model access and spend.

### Patch Changes

- [#160](https://github.com/pufflyai/pocketcoder/pull/160) [`7515826`](https://github.com/pufflyai/pocketcoder/commit/751582601404243dc2409dc73d1db453326682da) Thanks [@au-re](https://github.com/au-re)! - Enforce managed scope policy authority, session transitions, and durable storage cleanup, and align provisioning contracts.

## 0.8.0

### Minor Changes

- [#147](https://github.com/pufflyai/pocketcoder/pull/147) [`28398dc`](https://github.com/pufflyai/pocketcoder/commit/28398dc4b6fce647c11536b9b5c8f1f68fa9ec2a) Thanks [@au-re](https://github.com/au-re)! - Restore, recreate and resume accept `template_version` to move a preserved workspace onto another compatible version of its template, such as a newer image or new resource limits. Adds `pcd workspaces resume` and `--template-version`.

## 0.7.0

### Minor Changes

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Add principal administration over HTTP and bounded owner and recovery key issuance.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Store each conversation as JSON records written at turn boundaries, with several conversations per workspace: `client.conversations.listConversations`, `read`, `delete` and `live`, and `pcd workspaces conversations`.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Stage inputs in bounded controller storage with digest verification and opaque immutable references.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Start a private local controller, issue finite owner keys, and publish immutable templates over HTTP.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Expose the declared agent type and optional model on template and workspace resources.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Rotate machine keys with an overlapping successor and list keys that expire soon (`pcd keys rotate`, `pcd keys expiring`, `client.keys.rotate`, `client.keys.expiring`).

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Start private-image workspaces using encrypted controller-only registry references.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Interrupt the agent's current turn without ending the workspace, and stop the remote turn when Pi aborts a reply.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Run agents with renewable workspace credentials and revoke their authority during cleanup.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Open template-declared workspace webapps with authenticated browser previews and loopback forwarding.

### Patch Changes

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Expose queued admission reasons and ship reliable repeated replies with explicit turn completion support.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Open isolated HTTPS previews and displays with explicit parent-bound embedding and a cookie fallback.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Fetch private workspace source with a bounded setup lease that is revoked before agent startup.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Add canonical workload contracts, capability admission checks, and offline template tooling.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Preserve supplied conversation identities and reconcile accepted requests across workspace generations.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Persist execution intent and reconcile dispatch with operation-scoped cancellation.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Retain explicit conversation, activity, and terminal facts through v2 identified turns without inferring a final answer from agent status.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Open trusted workspace desktop viewers with server-enforced view and control permissions.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Fence purged accounts permanently and retry verified removal of their private data.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Add private off-node account backup and recovery commands and the pending journal error contract.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Recognize the `maintenance.active`, `maintenance.timeout` and `backup.failed` error codes.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Watch and control Chromium workspaces through trusted display sessions.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Publish qualified service workloads and deliver immutable files through durable conversation executions.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Add waiting supervisor control and durable finite process outcomes bound to container identity.

- [#139](https://github.com/pufflyai/pocketcoder/pull/139) [`963a21e`](https://github.com/pufflyai/pocketcoder/commit/963a21e29fb5b4ece6e8940e82321c25a47e925d) Thanks [@au-re](https://github.com/au-re)! - Capture private workspace screenshots with quota, authorized downloads, retention and purge.

## 0.6.1

### Patch Changes

- [#116](https://github.com/pufflyai/pocketcoder/pull/116) [`2d0a29a`](https://github.com/pufflyai/pocketcoder/commit/2d0a29a09df9e367bda96efbd356aaec15a1d987) Thanks [@au-re](https://github.com/au-re)! - Preserve supplied conversation identities and reconcile accepted requests across workspace generations.

- [#117](https://github.com/pufflyai/pocketcoder/pull/117) [`3f8e03d`](https://github.com/pufflyai/pocketcoder/commit/3f8e03dca7f8e7dfde5f81607663d94778228bd7) Thanks [@au-re](https://github.com/au-re)! - Retain explicit conversation, activity, and terminal facts through v2 identified turns without inferring a final answer from agent status.

## 0.6.0

### Minor Changes

- [#54](https://github.com/pufflyai/pocketcoder/pull/54) [`b683aef`](https://github.com/pufflyai/pocketcoder/commit/b683aef78eb471da4ac271895c74b7935c6e82ce) Thanks [@au-re](https://github.com/au-re)! - Add verifiable workspace purge and scoped principal-key cleanup, with unresolved ownership and termination fences and provider input removal.

## 0.5.0

### Minor Changes

- [#40](https://github.com/pufflyai/pocketcoder/pull/40) [`3c779c2`](https://github.com/pufflyai/pocketcoder/commit/3c779c2d40e6b756d4501069f3fa8d3002b84e9b) Thanks [@au-re](https://github.com/au-re)! - Wait for the agent to be ready for input before sending a user message, so a workspace that is ready but still starting no longer fails with an opaque 500.

## 0.4.0

### Minor Changes

- [#27](https://github.com/pufflyai/pocketcoder/pull/27) [`0d450c0`](https://github.com/pufflyai/pocketcoder/commit/0d450c0e66eb7417d460196b46690d15d3d879b6) Thanks [@au-re](https://github.com/au-re)! - Add reusable user-turn workspace resume and the typed embedded Pi adapter.

## 0.3.1

### Patch Changes

- [#25](https://github.com/pufflyai/pocketcoder/pull/25) [`537d96b`](https://github.com/pufflyai/pocketcoder/commit/537d96b9439a29e6903892f1538972424c8c99e2) Thanks [@au-re](https://github.com/au-re)! - Republish all public packages through trusted publishing with provenance.

## 0.3.0

### Minor Changes

- [#21](https://github.com/pufflyai/pocketcoder/pull/21) [`8ea16d7`](https://github.com/pufflyai/pocketcoder/commit/8ea16d767f18a5fa9c1a752222b08f91b450113d) Thanks [@au-re](https://github.com/au-re)! - Add restore launch input, deterministic template rendering, configurable PTY width, and the public Node SDK.
