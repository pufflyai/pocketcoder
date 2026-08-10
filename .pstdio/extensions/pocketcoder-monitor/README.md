# PocketCoder Monitor

Repo-local Prompt Studio extension that shows:

- every active PocketCoder workspace (`queued`, `provisioning`, `connected`, `ready`, or `terminating`);
- every template version authorized for the configured PocketCoder machine key.

**PocketCoder** in the project sidenav switches to the monitor workbench mode. It
refreshes every ten seconds and can also be refreshed manually.

The mode keeps the id `pocketcoder.pocketcoder-monitor.monitor` on purpose: the
dashboard persists that id in its navigation history and throws
`Workbench mode not registered` when it disappears (prompt-studio PS-225). Once that
is fixed upstream the mode can be renamed or dropped.

The extension runs the repository's `pcd` CLI, so the repository dependencies
must be installed and `POCKETCODER_URL` plus `POCKETCODER_KEY` must be available
through the process environment or the nearest `.env` file.
