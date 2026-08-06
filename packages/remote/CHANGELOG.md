# @pstdio/pocketcoder-remote

## 0.2.1

### Patch Changes

- [#19](https://github.com/pufflyai/pocketcoder/pull/19) [`4401c01`](https://github.com/pufflyai/pocketcoder/commit/4401c01b6851b8d26454850df249daf30e8ccb85) Thanks [@au-re](https://github.com/au-re)! - Bundle the workspace-only packages into the shipped extension so the tarball declares no unpublished dependencies.

## 0.2.0

### Minor Changes

- [#14](https://github.com/pufflyai/pocketcoder/pull/14) [`3c28cc3`](https://github.com/pufflyai/pocketcoder/commit/3c28cc377511fa7a70f2da9134c6f4bb12cb729d) Thanks [@au-re](https://github.com/au-re)! - Stream live remote agent snapshots into the local Pi TUI with compatible polling fallback.

- [#10](https://github.com/pufflyai/pocketcoder/pull/10) [`19ce56e`](https://github.com/pufflyai/pocketcoder/commit/19ce56eb5f827c51a43fd0854e1500729c7b353e) Thanks [@au-re](https://github.com/au-re)! - Add AgentAPI-native templates, direct workspace agent APIs, stable transcript capture, and hook-free checkpoint quiescing.

- [#11](https://github.com/pufflyai/pocketcoder/pull/11) [`e047fe6`](https://github.com/pufflyai/pocketcoder/commit/e047fe64cee4a68f9348abf5e94a32d107c4e554) Thanks [@au-re](https://github.com/au-re)! - Add a runtime-validated control-plane client and tighten idempotency, health, pagination, configuration, and API contracts.

- [#8](https://github.com/pufflyai/pocketcoder/pull/8) [`a267ee6`](https://github.com/pufflyai/pocketcoder/commit/a267ee69dcb858296244ac70865ab743c220aaf7) Thanks [@au-re](https://github.com/au-re)! - New package: a Pi-based terminal UI for PocketCoder workspaces. Runs local Pi as a thin client over the service relay with durable history replay, in-UI workspace picker/create/cancel commands, and a live workspace status bar.

- [#12](https://github.com/pufflyai/pocketcoder/pull/12) [`52d9c69`](https://github.com/pufflyai/pocketcoder/commit/52d9c69c604c36e80b8291496ca76554156168a7) Thanks [@au-re](https://github.com/au-re)! - Add workspace-native file attachments: streamed uploads into `$HOME/.pcd/attachments`, attachment-aware AgentAPI messages, CLI `--file` and chat `/attach` flows, and Pi image, `@path`, and `/attach` input.

### Patch Changes

- Updated dependencies [[`e047fe6`](https://github.com/pufflyai/pocketcoder/commit/e047fe64cee4a68f9348abf5e94a32d107c4e554), [`7c1cddf`](https://github.com/pufflyai/pocketcoder/commit/7c1cddfb3287f35b358aff9d421b7b8b74157e56), [`52d9c69`](https://github.com/pufflyai/pocketcoder/commit/52d9c69c604c36e80b8291496ca76554156168a7)]:
  - @pstdio/pocketcoder-client@0.2.0
