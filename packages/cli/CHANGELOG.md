# @pstdio/pocketcoder-cli

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
