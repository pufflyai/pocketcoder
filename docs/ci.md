# Continuous integration

PR updates target a 95th-percentile completion time below five minutes, including runner wait. A merge queue runs the full suite before changing a protected branch. The required check is named **CI** in both cases. The gate rejects failed, cancelled, missing, and unexpectedly skipped jobs.

## Fast PR feedback

Quality checks run on every update. Nx selects changed packages and all their dependents against the tested merge candidate's first parent. Type checks and unit and route tests run for those projects. Four Bun shards divide the test files across runners. Runtime changes also run a real local echo workspace through Docker and the server.

Root configuration, scripts, workflows, build recipes, unknown paths, and changes with no Nx owner select all projects. Changes limited to docs, changeset text, and contributor instructions still run quality checks. They receive full qualification when queued. The selection code and tests live in `scripts/ci/selection.ts` and `scripts/ci/diff.ts`. Event base metadata can lag the checkout; both Git and Nx compare with the same tested parent. The plan is recorded in the job summary.

Obsolete PR runs are cancelled. Queue runs and protected-branch runs finish so a later update cannot cancel the evidence needed for a merge or publication. Existing timeouts are not widened.

## Full merge qualification

The queue tests the checked-out merge result, using github.sha for builds and artifacts. Full mode selects all packages. Separate runners execute integration, repository contracts, performance, harnesses, package builds, and image qualification. The suite coverage check rejects a new root test command until it has a full-CI owner.

Full qualification includes embedded database checks on three platforms, native builds and clean installation, managed Docker and Kubernetes services, Helm installation, recovery and upgrade scenarios, monitoring, and image scans and smoke checks on both Linux architectures. PostgreSQL-backed store suites run whenever packages are selected. Reusable workflow gates require every dependency to pass, so adding a job does not require maintaining a second job list. The outer gate permits only deliberately unselected jobs to be skipped and rejects any failed or cancelled dependency. Job summaries record the actual gate results.

Add the full-ci label to a PR to qualify a CI change before rollout. Full checks can also be requested without a merge:

```sh
gh workflow run ci.yml --ref <branch> -f full=true
```

## PR area labels

The PR area labeler adds labels such as `cli`, `server` and `docs` from changed
paths. Area labels share the light-green color `#c2e0c6`. It covers each
package and the shared CI, deployment, docs, examples, extensions and tooling
areas. A PR can have several labels. The rules live in
[`.github/labeler.yml`](../.github/labeler.yml).

Only adding `full-ci` starts validation from a label event. Other label updates
use a separate concurrency group, skip validation, and do not publish a `CI`
check. They cannot cancel a running validation or replace its required result.

Labels refresh when a PR opens, reopens, receives commits or is edited. Area
labels that no longer match are removed. Labels outside that configuration,
such as `full-ci`, remain manually managed. The label workflow can also be run
with a PR number to refresh an older PR.

Automatic runs use the PR base branch's configuration. Manual runs use the
selected workflow ref's configuration. Both use GitHub's changed-file API and
never check out or run PR code, including for forked PRs. The job
can read repository files and manage PR labels; it cannot write source code.
New label names can be created automatically. Automatic labeling starts after
the workflow is merged into the base branch. Existing open PRs were labeled
once during setup.

## Caches and shared builds

PRs and queue jobs read shared Bun, Nx, and image layer caches. Only successful jobs running on protected branches may publish shared caches. Task cache keys separate the operating system, architecture, installed Bun version, lockfile, task group, and source revision. Setup and release workflows read Bun from `package.json`; cache keys use that installed version.

Nx build and typecheck results can be cached. Only auth's pure unit tests opt into test caching. Database, Docker, browser, provider, recovery, clock, and repository-wide contract tests run each time. Cached inputs include dependencies and shared build inputs.

Nx 23 stores local task records in a machine-specific database. scripts/ci/task-cache.ts exports successful task records beside their outputs and imports them into each new runner's database. It does not copy SQLite state or disable Nx cache checks. The lockfile pins this native API; its regression test restores results into a fresh database and checks invalidation after a source change.

Package output is built once per full run and shared by artifact name and source SHA. Harness and service images are built once for consumers in that run. Consumers verify the source revision, archive hash, and loaded Docker image ID. No registry credential is passed into a workspace.

Protected-branch pushes run fast smoke checks and package builds after merging. Scheduled runs repeat full qualification. Package and automatic image publication require successful CI from the same repository and protected-branch source SHA. A newer branch revision supersedes stale publication. Manual publication must find successful protected-branch CI for the same revision.

## Protected branches and rollout

Both main and feature/pocketcoder-1-0 require a PR, a merge queue, and the CI check from GitHub Actions. Rules have no bypass actors and block branch deletion and force pushes. Queue groups merge one PR at a time and require every selected job to pass. Use the normal merge queue; do not use an administrator bypass.

Install and qualify matching workflows before enabling a branch's rules. Existing PRs may need an update from their base branch to receive the new workflow. A green fast PR run does not replace full queue validation.

## Timing and local validation

The PR feedback timing workflow reports the latest twenty completed first-attempt fast PR runs. Opt-in full PR qualification and metadata-only label runs are excluded. It measures creation through completion, including runner wait, and reports p95 and whether it is below 300 seconds. Cancelled updates and human reruns are excluded. The JSON artifact and job summary retain the result. Initial samples can include older workflow runs. Hosted measurements are required before claiming the target is met.

Run the same local contributor checks before handoff:

```sh
bun run check
bun run typecheck
bun --no-env-file run test
bun run ci:test
```

Run `bun run pack:check` as well when publishable output changes.

Workflow syntax is checked with actionlint. Live Docker, Kubernetes, native platform, and hosted cache behavior are also verified by the full workflow. Fix a slow or failing check instead of widening its timeout or removing it from the gate.


## Investigating failures

After each push, wait for all applicable checks on that commit. Use `gh pr checks`
and `gh run view <run-id> --log-failed` to inspect failures. Separate runner setup,
build, test and cleanup time before changing code. Keep the PR open as a draft
when a required check remains blocked, and link evidence in its **Fix** and
**Downsides** sections. Full qualification uses the `full-ci` label so workflow
changes can be tested before merging. Never hide a failure with retries, skips,
smaller workloads, or wider timeouts.
