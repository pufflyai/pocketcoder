# @pstdio/pocketcoder-cli

## 0.8.0

### Minor Changes

- [#51](https://github.com/pufflyai/pocketcoder/pull/51) [`6252d15`](https://github.com/pufflyai/pocketcoder/commit/6252d1526e597a8325e9df4126dc93f0e4029c27) Thanks [@jenshorn](https://github.com/jenshorn)! - Add optional external launch admission with durable termination evidence and reservation reconciliation.

- [#54](https://github.com/pufflyai/pocketcoder/pull/54) [`b683aef`](https://github.com/pufflyai/pocketcoder/commit/b683aef78eb471da4ac271895c74b7935c6e82ce) Thanks [@au-re](https://github.com/au-re)! - Add verifiable workspace purge and scoped principal-key cleanup, with unresolved ownership and termination fences and provider input removal.

### Patch Changes

- [#52](https://github.com/pufflyai/pocketcoder/pull/52) [`e7afbce`](https://github.com/pufflyai/pocketcoder/commit/e7afbce70b7da49ba7293357b64f4d606497a4a2) Thanks [@jenshorn](https://github.com/jenshorn)! - Use one database connection for operator commands to avoid shutdown stalls during pool startup.

- [#51](https://github.com/pufflyai/pocketcoder/pull/51) [`6252d15`](https://github.com/pufflyai/pocketcoder/commit/6252d1526e597a8325e9df4126dc93f0e4029c27) Thanks [@jenshorn](https://github.com/jenshorn)! - Retry conflicting Kubernetes pod metadata updates while retaining termination evidence for checkpoints and cleanup.

- [#51](https://github.com/pufflyai/pocketcoder/pull/51) [`6252d15`](https://github.com/pufflyai/pocketcoder/commit/6252d1526e597a8325e9df4126dc93f0e4029c27) Thanks [@jenshorn](https://github.com/jenshorn)! - Retain Kubernetes node identity before autoscaling removes it and capture cancellation evidence for Pods that never received a node.

- [#50](https://github.com/pufflyai/pocketcoder/pull/50) [`d1522d2`](https://github.com/pufflyai/pocketcoder/commit/d1522d21b49d95421d3309493ec59bc3598f2edf) Thanks [@jenshorn](https://github.com/jenshorn)! - Retry incomplete termination after restart, keep recovery storage on process exit, and prevent heartbeats from delaying cleanup.

- [#51](https://github.com/pufflyai/pocketcoder/pull/51) [`6252d15`](https://github.com/pufflyai/pocketcoder/commit/6252d1526e597a8325e9df4126dc93f0e4029c27) Thanks [@jenshorn](https://github.com/jenshorn)! - Keep workspace capacity and provider references until termination cleanup succeeds, and retry failed warm-pool cleanup before requeueing.

## 0.7.3

### Patch Changes

- [#47](https://github.com/pufflyai/pocketcoder/pull/47) [`7a27b6b`](https://github.com/pufflyai/pocketcoder/commit/7a27b6b985594ea76f63d3d40672c2275a71ae32) Thanks [@jenshorn](https://github.com/jenshorn)! - Wait for initial warm-pool reconciliation before closing the database during server shutdown.

- [#47](https://github.com/pufflyai/pocketcoder/pull/47) [`7a27b6b`](https://github.com/pufflyai/pocketcoder/commit/7a27b6b985594ea76f63d3d40672c2275a71ae32) Thanks [@jenshorn](https://github.com/jenshorn)! - Read legacy JSON-encoded templates, workspace metadata, and checkpoint records after upgrading from 0.7.1.

- [#47](https://github.com/pufflyai/pocketcoder/pull/47) [`7a27b6b`](https://github.com/pufflyai/pocketcoder/commit/7a27b6b985594ea76f63d3d40672c2275a71ae32) Thanks [@jenshorn](https://github.com/jenshorn)! - Release preserved source storage after its last checkpoint is deleted, and retry interrupted cleanup during retention sweeps.

## 0.7.2

### Patch Changes

- [#45](https://github.com/pufflyai/pocketcoder/pull/45) [`2a3e252`](https://github.com/pufflyai/pocketcoder/commit/2a3e252f2de3ff47300e7704fd5ac8809cceacdb) Thanks [@jenshorn](https://github.com/jenshorn)! - Reuse one Kubernetes volume per PVC so workspaces with multiple persistent directories can start.

## 0.7.1

### Patch Changes

- [#38](https://github.com/pufflyai/pocketcoder/pull/38) [`3f07051`](https://github.com/pufflyai/pocketcoder/commit/3f0705136dd1a176e2c3a3c12a54bd42915c2660) Thanks [@jenshorn](https://github.com/jenshorn)! - Wait for AgentAPI to become stable before doctor sends its diagnostic message.

- [#40](https://github.com/pufflyai/pocketcoder/pull/40) [`3c779c2`](https://github.com/pufflyai/pocketcoder/commit/3c779c2d40e6b756d4501069f3fa8d3002b84e9b) Thanks [@au-re](https://github.com/au-re)! - Wait for the agent to be ready for input before sending a user message, so a workspace that is ready but still starting no longer fails with an opaque 500.

## 0.7.0

### Minor Changes

- [#36](https://github.com/pufflyai/pocketcoder/pull/36) [`ba746ae`](https://github.com/pufflyai/pocketcoder/commit/ba746aec6a78e80261d9feaa51598212b147c341) Thanks [@jenshorn](https://github.com/jenshorn)! - Add Kubernetes workspace node scheduling and ephemeral storage limits.

### Patch Changes

- [#35](https://github.com/pufflyai/pocketcoder/pull/35) [`cb12513`](https://github.com/pufflyai/pocketcoder/commit/cb125130e87697b90704f3dd70d380dfa2cf888e) Thanks [@au-re](https://github.com/au-re)! - Persist native AgentAPI transcripts when templates declare conversation restore support.

## 0.6.2

### Patch Changes

- [#28](https://github.com/pufflyai/pocketcoder/pull/28) [`0aae437`](https://github.com/pufflyai/pocketcoder/commit/0aae437eba7ee38127116ebb9c81d383bbfa52c4) Thanks [@au-re](https://github.com/au-re)! - Support root-squashed NFS workspace storage in the DigitalOcean Kubernetes example.

## 0.6.1

### Patch Changes

- [#25](https://github.com/pufflyai/pocketcoder/pull/25) [`537d96b`](https://github.com/pufflyai/pocketcoder/commit/537d96b9439a29e6903892f1538972424c8c99e2) Thanks [@au-re](https://github.com/au-re)! - Use the renamed workspace supervisor from the unified packages directory.

- [#25](https://github.com/pufflyai/pocketcoder/pull/25) [`537d96b`](https://github.com/pufflyai/pocketcoder/commit/537d96b9439a29e6903892f1538972424c8c99e2) Thanks [@au-re](https://github.com/au-re)! - Use Drizzle migration files directly in database commands.

- [#25](https://github.com/pufflyai/pocketcoder/pull/25) [`537d96b`](https://github.com/pufflyai/pocketcoder/commit/537d96b9439a29e6903892f1538972424c8c99e2) Thanks [@au-re](https://github.com/au-re)! - Republish all public packages through trusted publishing with provenance.

- [#25](https://github.com/pufflyai/pocketcoder/pull/25) [`537d96b`](https://github.com/pufflyai/pocketcoder/commit/537d96b9439a29e6903892f1538972424c8c99e2) Thanks [@au-re](https://github.com/au-re)! - Run resource actions through nested yargs handlers with scoped help.

- [#25](https://github.com/pufflyai/pocketcoder/pull/25) [`537d96b`](https://github.com/pufflyai/pocketcoder/commit/537d96b9439a29e6903892f1538972424c8c99e2) Thanks [@au-re](https://github.com/au-re)! - Explain why the CLI package exists and what it does.

## 0.6.0

### Minor Changes

- [#21](https://github.com/pufflyai/pocketcoder/pull/21) [`8ea16d7`](https://github.com/pufflyai/pocketcoder/commit/8ea16d767f18a5fa9c1a752222b08f91b450113d) Thanks [@au-re](https://github.com/au-re)! - Add restore launch input, deterministic template rendering, configurable PTY width, and the public Node SDK.

### Patch Changes

- [#20](https://github.com/pufflyai/pocketcoder/pull/20) [`ab21d6c`](https://github.com/pufflyai/pocketcoder/commit/ab21d6c7c09f1f4b019b36b93fe70b85b6280869) Thanks [@au-re](https://github.com/au-re)! - Deliver repository credentials only to create-time setup and clear them before the workspace harness starts.

## 0.5.0

### Minor Changes

- [#17](https://github.com/pufflyai/pocketcoder/pull/17) [`822218a`](https://github.com/pufflyai/pocketcoder/commit/822218ab11bfd11fe7f463dd9e0de6bc4b58d8ee) Thanks [@au-re](https://github.com/au-re)! - Add `pcd --version`, which prints the installed CLI version.

## 0.4.0

### Minor Changes

- [#10](https://github.com/pufflyai/pocketcoder/pull/10) [`19ce56e`](https://github.com/pufflyai/pocketcoder/commit/19ce56eb5f827c51a43fd0854e1500729c7b353e) Thanks [@au-re](https://github.com/au-re)! - Add principal updates and make default machine keys inherit live scopes.

- [#10](https://github.com/pufflyai/pocketcoder/pull/10) [`19ce56e`](https://github.com/pufflyai/pocketcoder/commit/19ce56eb5f827c51a43fd0854e1500729c7b353e) Thanks [@au-re](https://github.com/au-re)! - Add AgentAPI-native templates, direct workspace agent APIs, stable transcript capture, and hook-free checkpoint quiescing.

- [#11](https://github.com/pufflyai/pocketcoder/pull/11) [`e047fe6`](https://github.com/pufflyai/pocketcoder/commit/e047fe64cee4a68f9348abf5e94a32d107c4e554) Thanks [@au-re](https://github.com/au-re)! - Add a runtime-validated control-plane client and tighten idempotency, health, pagination, configuration, and API contracts.

- [#15](https://github.com/pufflyai/pocketcoder/pull/15) [`7c1cddf`](https://github.com/pufflyai/pocketcoder/commit/7c1cddfb3287f35b358aff9d421b7b8b74157e56) Thanks [@au-re](https://github.com/au-re)! - Add template-gated, audited, reconnecting workspace terminal sessions.

- [#11](https://github.com/pufflyai/pocketcoder/pull/11) [`e047fe6`](https://github.com/pufflyai/pocketcoder/commit/e047fe64cee4a68f9348abf5e94a32d107c4e554) Thanks [@au-re](https://github.com/au-re)! - Add restricted workspace networking and durable egress audit inspection.

- [#12](https://github.com/pufflyai/pocketcoder/pull/12) [`52d9c69`](https://github.com/pufflyai/pocketcoder/commit/52d9c69c604c36e80b8291496ca76554156168a7) Thanks [@au-re](https://github.com/au-re)! - Add workspace-native file attachments: streamed uploads into `$HOME/.pcd/attachments`, attachment-aware AgentAPI messages, CLI `--file` and chat `/attach` flows, and Pi image, `@path`, and `/attach` input.

## 0.3.0

### Minor Changes

- [#5](https://github.com/pufflyai/pocketcoder/pull/5) [`90ab090`](https://github.com/pufflyai/pocketcoder/commit/90ab0907456dafc216f975c9ae84836332caaff3) Thanks [@au-re](https://github.com/au-re)! - Add durable agent session history: workspace conversation transcripts are persisted and paginated, with authenticated history and deletion APIs, conversation-aware resume from checkpoints that declare support, and new `conversations:read` / `conversations:delete` scopes.

- [#5](https://github.com/pufflyai/pocketcoder/pull/5) [`90ab090`](https://github.com/pufflyai/pocketcoder/commit/90ab0907456dafc216f975c9ae84836332caaff3) Thanks [@au-re](https://github.com/au-re)! - Add configurable warm workspace pools that keep pre-provisioned workspaces ready per template version, and a `pcd pools list` command to inspect warm pool inventory and metrics.

## 0.2.0

### Minor Changes

- [#2](https://github.com/pufflyai/pocketcoder/pull/2) [`deb6b65`](https://github.com/pufflyai/pocketcoder/commit/deb6b655fe784748008bb6d1b589384505bfa1db) Thanks [@au-re](https://github.com/au-re)! - Add safe server start/status/stop lifecycle commands, workspace create waiting,
  interactive AgentAPI chat, and actionable launch-failure output.

- [#2](https://github.com/pufflyai/pocketcoder/pull/2) [`deb6b65`](https://github.com/pufflyai/pocketcoder/commit/deb6b655fe784748008bb6d1b589384505bfa1db) Thanks [@au-re](https://github.com/au-re)! - Rename the installed operator CLI executable from `pocketcoderctl` to `pcd`.

- [#2](https://github.com/pufflyai/pocketcoder/pull/2) [`deb6b65`](https://github.com/pufflyai/pocketcoder/commit/deb6b655fe784748008bb6d1b589384505bfa1db) Thanks [@au-re](https://github.com/au-re)! - Make `pcd doctor` require a correlated request/response turn, expose
  failure diagnostics and workspace change cursors, and document the complete
  PocketCoder migration and digest-pinned release flow.

- [`5aee0dd`](https://github.com/pufflyai/pocketcoder/commit/5aee0dd5c9124fd8d58a640a97e161580bc6a8a5) Thanks [@au-re](https://github.com/au-re)! - Add attach, preserve, restore, recreate, checkpoint, output, and storage maintenance commands for durable remote workspaces.

### Patch Changes

- [`865fab4`](https://github.com/pufflyai/pocketcoder/commit/865fab4b789512e5e74baa741470f33f604484eb) Thanks [@au-re](https://github.com/au-re)! - Publish the operator CLI as `@pstdio/pocketcoder-cli`.

- [`db90cc4`](https://github.com/pufflyai/pocketcoder/commit/db90cc401f00f21201970f602143ab4ebe409868) Thanks [@au-re](https://github.com/au-re)! - Use yargs for command parsing, print contextual help when required arguments are missing, and load project-scoped `.env` configuration.

- [`d06b66d`](https://github.com/pufflyai/pocketcoder/commit/d06b66df1196bf4aa99a6c479686d7061ae3f6da) Thanks [@au-re](https://github.com/au-re)! - Publish PocketCoder's bundled operator CLI while keeping its implementation packages private.
