# PC-1 validation evidence

Validation was run from:

```text
/Users/au-re/Documents/Projects/pocketcoder
base commit: 5b69cfe
date: 2026-07-30
```

## Quality, tests, types, and builds

```text
$ bun run check
Checked 118 files. No fixes applied.
Found 15 warning-level cognitive-complexity notices.
Biome exit 0; Knip exit 0.

$ bun test
96 pass
1 skip (PostgreSQL URL not supplied to this invocation)
0 fail
377 expect() calls

$ POCKETCODER_TEST_DATABASE_URL=postgres://pocketcoder:…@127.0.0.1:5433/pocketcoder \
    bun test packages/db/src/store.test.ts
3 pass
0 fail
25 expect() calls

$ bun test packages/drivers/src/filesystem-storage.test.ts
3 pass
0 fail
14 expect() calls

$ bun run typecheck
Successfully ran target typecheck for 9 projects.

$ bun run build
Successfully ran target build for agent, server, and CLI.

$ git diff --check
exit 0
```

## Behaviors exercised

```text
REST persistence:
- preserve and same-key idempotency
- immutable checkpoint verification
- new-workspace restore and same-key idempotency
- origin/checkpoint lineage
- independent writable restored storage
- restore-mode provider input
- declared bounded outputs

Filesystem checkpoint backend:
- content hashes and corruption rejection
- modes and mtimes
- safe relative symlinks
- byte/file accounting and quota rejection
- traversal/escaping symlink rejection
- opaque storage reference validation
- read-only immutable source with independent restore clones

Portable runtime/storage:
- Docker bind-mount and secret projection
- Kubernetes Job, PVC, Secret, tmpfs, resource, and security projection
- Kubernetes service-account token disabled in workspace Jobs
- file and Kubernetes secret resolver validation
- local/Kubernetes configuration and partial-config fail-closed behavior
- policy-driven scheduler preservation
```

## Package

```text
$ npm pack --dry-run --json  # packages/cli
@pstdio/pocketcoder-cli@0.1.0
files:
- LICENSE
- README.md
- dist/index.js
- package.json
exit 0

$ bun run changeset:status
@pstdio/pocketcoder-cli: minor
exit 0
```
