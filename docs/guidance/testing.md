# Workflow: TDD

1. **Red** — write the smallest failing test first (reproduce bugs before fixing them). Skip only for config/docs-only changes.
2. **Green** — write the minimum code to pass.
3. **Refactor** — clean up, delete dead code, keep tests green.
4. **Prove it** — run `bun run check`, `bun run typecheck`, and `bun --no-env-file run test` before finishing. If publishable output changed, run `bun run pack:check`.

## Testing

- Tests live next to the file they test.
- Avoid mocks — test the real thing.
- Bug fixes require a regression test.
- No tests for config/docs changes, literal bundled copy, or proving removed code stays gone.

## Test environment

Use the version of Bun pinned by `packageManager` in `package.json`. CI reads
that file too. Start full suites with `bun --no-env-file run test` or
`bun --no-env-file run test:postgres` to make environment-file isolation explicit
at the entrypoint. Test scripts also use `bun --no-env-file test`, and Lerna
disables loading `.env` files. Keep developer controller settings out of test processes.
Explicit environment variables still reach tests, so clear operator settings
such as `POCKETCODER_DATABASE_URL` before running them.

Use targeted tests during development. Run the required root checks before
handoff. Do not rerun passing checks unless a later change affects them.
Live Docker, Kubernetes, PostgreSQL and browser checks need their real runtimes.
Record unavailable prerequisites and skipped checks; do not call them passes.

When running Docker-backed startup failure checks, prepare their pinned object
store image before the suite. CI pulls it before the test step so a registry
download does not consume the startup test's execution allowance:

```sh
docker pull rustfs/rustfs@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff
```

The extension end-to-end tests also reuse the workspace image manifest when
`POCKETCODER_CI_IMAGE_MANIFEST` is set. Full CI loads the verified shared image
before running them. Build that external fixture before the timed agent flow
when validating from a cold local Docker cache.

## Performance and timeouts

A performance budget measures one operation under a fixed workload. A timeout
bounds an entire test or job, including setup and cleanup. Find the slow phase
before changing either. Do not pass a check by shrinking its workload, retrying
until it passes, or prewarming a cold-start scenario.

Never increase a budget or timeout without explicit approval for that value.
Report the measured failure and its evidence when it remains unresolved.
