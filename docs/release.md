# Release checklist

The next PocketCoder controller/CLI release is **0.9.0**. Earlier plans and ADRs
called this unreleased line 1.0; the source branch remains
`feature/pocketcoder-1-0`. API, execution, storage and template format versions
are unchanged. The SDK and remote client keep their independent package versions.

Changesets must plan a minor CLI release from 0.8.x to 0.9.0. Breaking changes
in this pre-1.0 release still belong in the release notes, including removed
platforms and changed controller configuration. Do not edit package versions
by hand; the release workflow applies the Changesets plan.

Every release upgrades the previous release's database in place. Operators never
need a fresh controller, new principals or new keys to take a release.

## Before tagging

1. **Shipped migrations are unchanged.** `bun run check` runs
   `scripts/check-migrations.ts`. It fails when a migration that shipped in an
   earlier release was edited or removed. Shipped migrations are listed with their
   hashes in `packages/db/shipped-migrations.json`. Change the schema with a new
   migration (`bun run db:generate`), never by editing an old one.
2. **The upgrade test passes.** With a disposable PostgreSQL server:

   ```sh
   POCKETCODER_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres bun run test:postgres
   ```

   `scripts/upgrade/upgrade.test.ts` checks out the previous releases from their
   tags, migrates and seeds a database with each release's own code (principals,
   keys, templates, workspaces, checkpoints, conversation history), then upgrades
   it with the candidate. The test passes only when keys still authenticate,
   admission works, history reads back and old checkpoints end with their
   documented result. CI runs the same test in the `stores` job.

   - PostgreSQL starts from the last 0.8.x release (and a database first written
     by 0.7.1).
   - PGlite has no shipped release yet. Add the first 0.9 release to the test as
     soon as it is tagged.
3. **Release notes name every manual step.** The default is none. If a release
   needs one, the notes say what it is and which databases it applies to.

## After tagging

Record the migrations the release shipped, then commit the manifest:

```sh
bun scripts/check-migrations.ts <tag>
```

Add the new tag to the upgrade test cases, so the next release upgrades from it.

## Exceptions

A migration that shipped on a line that the next release does not continue is
reconciled by an upgrade step instead of being shipped again. 0.8.1's
`20261013125843_tiny_marvel_zombies` is the only one: the 0.9 migrator detects
it, applies only the constraints from `20261014100009_marvelous_praxagora` that
it lacks and records that migration with its real hash. See
[migration](migration.md#upgrade-from-08x-on-postgresql).
