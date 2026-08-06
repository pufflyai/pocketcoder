# Changesets

PocketCoder publishes two npm packages: `@pstdio/pocketcoder-cli` and
`@pstdio/pocketcoder-remote`. Add a changeset whenever a change affects a
published package's behavior, API, contracts, or packaged output — including
changes to the private packages they bundle. Do not add changesets for
private-package-only tests or refactors.

```sh
bun run changeset
```

Commit the generated Markdown file with the implementation. On `main`, the
`Release Packages` workflow versions, tags, packs, and publishes non-private
packages. Private workspaces are never released.
