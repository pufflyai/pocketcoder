# Local validation evidence

PC-3 was applied to a clean detached worktree based on:

```text
865fab4b789512e5e74baa741470f33f604484eb
rename packages to pstdio namespace
```

This kept the unrelated persistence/storage changes in the shared worktree out
of the result.

```text
$ bun install --frozen-lockfile
1288 packages installed
exit 0

$ bun run check
Checked 103 files. No fixes applied.
exit 0

$ bun run check-licenses:test
1 pass, 0 fail
The installed GPL-3.0-only fixture dependency was rejected.
exit 0

$ bun run check-licenses
Checked 631 installed packages.
MIT: 419
ISC: 146
Apache-2.0: 17
BlueOak-1.0.0: 17
BSD-2-Clause: 14
BSD-3-Clause: 7
Other explicitly allowed SPDX licenses: 11
exit 0

$ bun run typecheck
Successfully ran target typecheck for 9 projects.
exit 0

$ bun run example:test
1 pass, 0 fail
exit 0

$ bun run test
@pstdio/pocketcoder-auth:          6 pass
@pstdio/pocketcoder-contracts:    14 pass
@pstdio/pocketcoder-runtime-core: 10 pass
@pstdio/pocketcoder-drivers:       2 pass
@pstdio/pocketcoder-db:            2 pass, 1 PostgreSQL test skipped
@pstdio/pocketcoder-cli:          20 pass
@pstdio/pocketcoder-server:       19 pass
Total:                            73 pass, 0 fail, 1 skip
exit 0

$ bun run build
Successfully ran target build for agent, server, and CLI.
exit 0
```

## Published-version package check

```text
$ bun run pack:check
Checking npm package contents for @pstdio/pocketcoder-cli
name: @pstdio/pocketcoder-cli
version: 0.1.0
filename: pstdio-pocketcoder-cli-0.1.0.tgz
entryCount: 4
files: LICENSE, README.md, dist/index.js, package.json
exit 0

$ find packages/cli -maxdepth 1 -name '*.tgz'
no output
```
