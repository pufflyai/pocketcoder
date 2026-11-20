# Remote Testing

Run this repository's test suite on a PocketCoder deployment instead of your machine, and
manage the remote test environments. Agents get the same commands and the
`run-tests-remotely` skill.

A run uploads the working tree as Git sees it: committed files, uncommitted edits and new
files that are not ignored. It starts an isolated environment, runs the test
command there, stops the environment when the run finishes, and saves the full log under
`.pstdio/extension-storage/pocketcoder.remote-testing/runs/`.

## Remote tests page

**Remote tests** in the project sidebar has two tabs:

- **Runs**: every run with its status, command, the session that started it, environment,
  start time, duration, exit code and log. Prompt Studio collects results in the background
  after the CLI returns. Double-click a run, or use its menu, to
  open its session. The menu also cancels a running run.
- **Environments**: running test environments, whether each is free or which run holds it,
  whether it uses the current template, and when it stops. Start one ahead of time, stop one
  from its menu, or stop all.

`pst` passes the calling agent's session to `run` automatically, so agents do not need to do
anything for the link. Runs started outside a session show "Not recorded".

## Commands

```sh
pst pocketcoder.remote-testing status
pst pocketcoder.remote-testing run --path "$(git rev-parse --show-toplevel)" [--command "<cmd>"] [--wait false] [--keep-environment true]
pst pocketcoder.remote-testing runs list | show --run-id <id> | cancel --run-id <id>
pst pocketcoder.remote-testing environments list | create | stop --environment <id> | stop --all
```

## Branch and workspace templates

Use **Remote tests → Runs → Run tests** or **Run Prompt Studio**. An agent can also launch from this project's CLI and pass another repository or worktree with `--path`.

```sh
pst pocketcoder.remote-testing run --path /path/to/worktree --ref feature/my-branch
pst pocketcoder.remote-testing run --path /path/to/worktree --branch-template true
pst pocketcoder.remote-testing preview run --path /path/to/worktree --ref feature/my-branch
pst pocketcoder.remote-testing preview open --workspace-id <workspace-id>
pst pocketcoder.remote-testing templates branch --kind tests --path /path/to/worktree --ref feature/my-branch
```

`--ref` packages the named Git commit. With no ref, the launcher uses the current worktree, including uncommitted files that Git does not ignore. A `--ref` launch uses the approved template and transfers the commit with real Git history. Only `--branch-template` publishes a separate snapshot template. Use `--command` if the workspace needs a different test command than the project default. Tests stop their machine after collection unless explicitly kept. Prompt Studio uses a build of the snapshot when the source is Prompt Studio itself, or opens the snapshot as a project in a pinned Prompt Studio release.

`templates branch` registers the version and returns its name. The launch commands also upload the source and start a workspace.

On Kito, **preview open** uses the operator's HTTPS bridge on this device. The hostname can serve one workspace at a time and the returned link signs in one browser. Another live preview can keep running in its own workspace.

## Set up

The deployment uses the [PocketCoder Helm chart](../../../deploy/helm/pocketcoder): a controller with the
`remote-tests` template, a Cloud Storage bucket and a URL signer account.

1. Configure the **PocketCoder remote tests** connection with the controller URL and a
   finite machine key for the `remote-testing` principal. The host keeps the key; it never
   reaches settings, the repository or a test environment.
2. Set the extension settings: the template version, the test command, the bucket and the
   signer account.
3. Log in to Google once with `gcloud auth application-default login`. Uploads, downloads
   and URL signing use that login. Your account needs object access to the bucket and
   permission to sign as the signer account; the cluster stage grants both to
   `remote_test_developers`.

The generic runner has no Docker daemon. Review and full qualification require the pinned
`prompt-studio-review` image and an operator-authorized Kata placement. A missing daemon
or browser pin fails preflight; it never shrinks the test selection.

## Exact source and partial qualification

Runs transfer the history through pinned `origin/main` plus a thin head bundle. A dirty
upload is a head commit with an uncommitted overlay. Logs and `test-results/` are retained
under the extension's `runs/` folder. Review runs also collect the candidate's detailed
reports from their private disk-backed temporary directory. GET URLs expire after 30 minutes; PUT URLs expire at
the run timeout plus 30 minutes, bounded by the workspace deadline. The saved ledger contains no signed URLs.
While tests run, the runner saves partial logs and results every 30 seconds. Each results
snapshot is limited to 64 MiB and 20 seconds. Captures run one at a time and add some archive
and upload work. Separate objects keep snapshots from replacing final results. After a lost
runtime, the collector can retain the latest snapshot as `partial` evidence. Partial evidence
never proves a passing run. The archive includes `evidence-snapshot.json` with its capture time.
The URL signer needs object-create permission for uploads. Replacing a snapshot also needs
`storage.objects.delete` on the `checkpoints/` object prefix. Scope that permission with a
bucket IAM condition on `resource.name`; each workspace still receives only a signed PUT
URL for its own run object, bounded by its deadline.

```sh
pst pocketcoder.remote-testing run --path <repo> --ref <sha> --requires git-history,docker,browsers --command "bun install --frozen-lockfile && bun run test:review --base origin/main"
pst pocketcoder.remote-testing qualify --path <repo> --ref <sha>
pst pocketcoder.remote-testing suites show --suite-id <id>
```

Set **Qualification templates** to a JSON object such as:

```json
{"linux-x64":{"name":"prompt-studio-review","version":"2.0.0"},"linux-arm64":{"name":"prompt-studio-review-arm64","version":"2.0.0"}}
```

A discovery run executes the candidate's own stable platform exports from
`scripts/ci/production-platforms.ts` on a workspace. Computed targets are included; missing
exports fail discovery. Candidate code never runs on the operator host. The suite pins
one head and base for discovery and every target. Each target uses its own template and
checks its actual OS and architecture, generates the candidate full-stage plan, and calls
the candidate executor with every row assigned to that host. The complete plan, source,
digest, assigned run IDs, and execution report remain in `test-results/qualification/`.
macOS and Windows have no workers in
PC-195; PC-197 tracks those. They remain `no_worker`, and the suite is `incomplete` with
partial coverage. Failures and reruns keep separate run IDs. A suite can pass only when
every required target passed.

For branch launches, install approved rendered manifests as `branch-templates/tests.json` and `branch-templates/preview.json` in this extension's project storage. Configure **PocketCoder branch templates** with a finite `templates:write` key scoped to `remote-tests-branch` and `prompt-studio-preview-branch`. Configure the runner key to launch both branch families. Both keys stay on the Prompt Studio host.


## Package the companion

Bundle private workspace imports before sharing this extension:

```sh
bun run --cwd .pstdio/extensions/remote-testing build
pst extensions pack .pstdio/extensions/remote-testing/dist --out-dir <output-folder>
```

The distributable contains the protocol schemas and static skills. It needs only the
published Prompt Studio SDK, so installing it never tries to fetch a private workspace
package from npm. Keep the source extension in the repository for development.
