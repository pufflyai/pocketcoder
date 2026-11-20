---
name: run-tests-remotely
description: "Run the repository's test suite on a remote PocketCoder environment instead of this machine, and manage those environments. Use whenever you need to run the full test suite or another long test command, and remote testing is available."
metadata:
  version: 0.1.0
---

Remote testing runs a test command on a cloud machine. It uploads your working tree as Git sees it: committed files, your uncommitted edits and new files that are not ignored. It does not upload `node_modules`, build output or anything in `.gitignore`. Your machine stays free while the tests run.

## Check that it is available

```sh
pst pocketcoder.remote-testing status
```

`available: true` means you can use it. If it says `available: false`, run the tests locally as usual and mention the listed problems to the user. Do not try to fix the setup yourself.

## Run the test suite

From the repository root:

```sh
pst pocketcoder.remote-testing run --path "$(git rev-parse --show-toplevel)"
```

This waits until the run ends and prints JSON:

- `status`: `passed`, `failed`, `timed_out`, `canceled` or `error`
- `exitCode`: the test command's exit code
- `tail`: the last 60 lines of output
- `logPath`: the full log on this machine. Search it with `rg` or read the relevant parts. Do not print the whole file.
- `runId` and `environmentId`

Without `--command`, the run uses the project's configured test command (`testCommand` in `status`). To run part of the suite, pass a shell command that runs in the repository root, for example:

```sh
pst pocketcoder.remote-testing run --path "$(git rev-parse --show-toplevel)" --command "bun install --frozen-lockfile && bun run test:unit"
```

The run is linked to your session automatically, and the user can follow it on the **Remote tests** page.

A run starts an isolated environment unless you select one with `--environment <id>`. It stops the environment after the result is finalized, including when the suite fails. Pass `--keep-environment true` to keep it warm, then select its ID explicitly for another run.

If the remote result disagrees with what you expect, look for the cause in the log first. The remote machine is Linux amd64, not this machine's platform.

## Long runs

Add `--wait false` to start a run and get its `runId` immediately. Then wait for it later:

```sh
pst pocketcoder.remote-testing runs show --run-id <runId>
```

`runs show` also picks up a run whose `run` command was interrupted. `runs list` shows recent runs. `runs cancel --run-id <runId>` stops a run.

## Manage environments

```sh
pst pocketcoder.remote-testing environments list                 # id, state, busy
pst pocketcoder.remote-testing environments create               # start one ahead of time
pst pocketcoder.remote-testing environments stop --environment <id>
pst pocketcoder.remote-testing environments stop --all
```

Environments expire at the approved template's deadline. Stop the ones you started when your task is done and you do not expect more runs soon. During concurrent work, stop only your own environment IDs.

## Agent branch workspaces

Pass `--path` for the target worktree. Use `--ref <branch-or-commit>` to test an exact commit, or `--branch-template true` to publish a version for the current worktree including uncommitted edits. For a Prompt Studio instance, use `pst pocketcoder.remote-testing preview run --path <worktree> [--ref <branch-or-commit>]`. When it returns a workspace ID, run `pst pocketcoder.remote-testing preview open --workspace-id <id>` to obtain a browser link on the Kito operator device. Share the expiring link only with the intended viewer.

## Review and full qualification

Use a clean commit with `--ref <sha>` for review. Source uses real Git bundles and a pinned
`origin/main`; dirty working trees remain dirty overlays. `--ref` uses the approved image,
not a template per branch. Run `test:review` with `--requires git-history,docker,browsers`.
The pinned review image and a Kata engine placement are required. Do not replace missing
prerequisites with skipped tests or different tool versions. TMPDIR stays on workspace disk.

Use `pst pocketcoder.remote-testing qualify --path <repo> --ref <sha>` for all candidate
hosts, then `pst pocketcoder.remote-testing suites show --suite-id <id>` to collect the
ledger. Configure the available host templates first. Missing macOS and Windows workers
remain `no_worker`; Linux-only coverage is partial and the suite is incomplete. Never
claim full qualification from Linux-only evidence. The run timeout stays at 60 minutes.

Collect the full log and results archive, including failures, before reporting. Verify
owned test environments stop. Record source head, base, merge base, tree, host, template,
image, placement, pins, status and evidence paths. Never put signed URLs or credentials in
commits or public reports.
