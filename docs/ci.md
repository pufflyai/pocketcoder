# Continuous integration

PR updates target a 95th-percentile completion time below five minutes, including runner wait. A merge queue runs the full suite before changing a protected branch. The required check is named **CI** in both cases. The gate rejects failed, cancelled, missing, and unexpectedly skipped jobs.

## Fast PR feedback

Quality checks run on every update. Nx selects changed packages and all their dependents against the PR's actual base revision. Type checks and unit and route tests run for those projects. Four Bun shards divide the test files across runners. Runtime changes also run a real local echo workspace through Docker and the server.

Root configuration, scripts, workflows, build recipes, unknown paths, and changes with no Nx owner select all projects. Changes limited to docs, changeset text, and contributor instructions still run quality checks. They receive full qualification when queued. The selection code and tests live in scripts/ci/selection.ts.

Obsolete PR runs are cancelled. Queue runs and protected-branch runs finish so a later update cannot cancel the evidence needed for a merge or publication. Existing timeouts are not widened.

## Full merge qualification

The queue tests the checked-out merge result, using github.sha for builds and artifacts. Full mode selects all packages. Separate runners execute integration, repository contracts, performance, harnesses, package builds, and image qualification. The suite coverage check rejects a new root test command until it has a full-CI owner.

The 0.9 integration branch (`feature/pocketcoder-1-0`) also requires embedded database checks on three platforms, native builds and clean installation, managed Docker and Kubernetes services, recovery and upgrade scenarios, monitoring, and image scans and smoke checks on both Linux architectures. Main keeps PostgreSQL-backed tests and validates its three existing image roles on both architectures. These are separate changes because main does not contain the unreleased 0.9 product.

Add the full-ci label to a PR to qualify a CI change before rollout. Full checks can also be requested without a merge:

```sh
gh workflow run ci.yml --ref <branch> -f full=true
```

## Caches and shared builds

PRs and queue jobs read shared Bun, Nx, and image layer caches. Only successful jobs running on protected branches may publish shared caches. Keys separate the operating system, architecture, Bun version, lockfile, task group, and source revision.

Nx build and typecheck results can be cached. Only auth's pure unit tests opt into test caching. Database, Docker, browser, provider, recovery, clock, and repository-wide contract tests run each time. Cached inputs include dependencies and shared build inputs.

Nx 23 stores local task records in a machine-specific database. scripts/ci/task-cache.ts exports successful task records beside their outputs and imports them into each new runner's database. It does not copy SQLite state or disable Nx cache checks. The lockfile pins this native API; its regression test restores results into a fresh database and checks invalidation after a source change.

Package output is built once per full run and shared by artifact name and source SHA. Harness and service images are built once for consumers in that run. Consumers verify the source revision, archive hash, and loaded Docker image ID. No registry credential is passed into a workspace.

Protected-branch pushes run fast smoke checks and package builds after merging. Scheduled runs repeat full qualification. Package and automatic image publication require successful CI from the same repository and protected-branch source SHA. A newer branch revision supersedes stale publication. Manual publication must find successful protected-branch CI for the same revision.

## Protected branches and rollout

Both main and feature/pocketcoder-1-0 require a PR, a merge queue, and the CI check from GitHub Actions. Rules have no bypass actors and block branch deletion and force pushes. Queue groups merge one PR at a time and require every selected job to pass. Use the normal merge queue; do not use an administrator bypass.

Install and qualify the matching workflows before enabling a branch's rules. Keep the main bootstrap PR separate from the 0.9 integration change. Existing PRs may need an update from their base branch to receive the new workflow. A green fast PR run does not replace full queue validation.

## Timing and local validation

The PR feedback timing workflow reports the latest twenty completed first-attempt fast PR runs. Opt-in full PR qualification is excluded. It measures creation through completion, including runner wait, and reports p95 and whether it is below 300 seconds. Cancelled updates and human reruns are excluded. The JSON artifact and job summary retain the result. Initial samples can include older workflow runs. Hosted measurements are required before claiming the target is met.

Run the same local contributor checks before handoff:

```sh
bun run check
bun run typecheck
bun run test
bun run pack:check
bun run ci:test
```

Workflow syntax is checked with actionlint. Live Docker, Kubernetes, native platform, and hosted cache behavior are also verified by the full workflow. Fix a slow or failing check instead of widening its timeout or removing it from the gate.
