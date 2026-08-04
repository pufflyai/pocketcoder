# @pstdio/pocketcoder-cli

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
