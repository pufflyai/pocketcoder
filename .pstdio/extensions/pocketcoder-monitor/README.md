# PocketCoder Monitor

Repo-local Prompt Studio extension that shows:

- every active PocketCoder workspace (`queued`, `provisioning`, `connected`, `ready`, or `terminating`);
- every template version authorized for the configured PocketCoder machine key.

The page appears as **PocketCoder** in the project sidenav. It refreshes every ten
seconds and can also be refreshed manually.

The extension runs the repository's `pcd` CLI, so the repository dependencies
must be installed and `POCKETCODER_URL` plus `POCKETCODER_KEY` must be available
through the process environment or the nearest `.env` file.
