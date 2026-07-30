# GitHub validation evidence

Final commit:
`5b69cfebc0c336756b3c53587e8f247611d9a9aa`

## License Compliance Check

Run:
https://github.com/pufflyai/pocketcoder/actions/runs/30541587716

```text
Conclusion: success
licenses (16s):
- frozen Bun install
- disallowed-license regression test
- 631-package dependency license scan
```

## Release Packages

Run:
https://github.com/pufflyai/pocketcoder/actions/runs/30541587695

```text
Conclusion: success
Version or publish packages (1m12s):
- formatting and lint
- typechecks
- tests
- builds
- npm package-content verification
- Changesets version/publish handling
```

The content-verification step passed even though
`@pstdio/pocketcoder-cli@0.1.0` is already published.

## CI

Run:
https://github.com/pufflyai/pocketcoder/actions/runs/30541587725

```text
Conclusion: success
test (1m59s): success
images (2m45s): success
```

The test job covered frozen install, formatting, all workspace typechecks,
fixture validation, full-stack E2E, PostgreSQL integration, and builds. The
image job built and pushed both multi-architecture images.
