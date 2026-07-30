# Changesets

`@pstdio/pocketcoder-cli` is Pocketcoder's public npm package. Every other
workspace is private and imported directly inside the monorepo. Do not add
changesets for changes that affect only private packages.

Add a changeset for every user-visible CLI change:

```sh
bun run changeset
```

Commit the generated Markdown file with the implementation. On `main`, the
`Release Packages` workflow considers only non-private packages, maintains their
version pull request, and publishes them to npm. Private packages are never
versioned, tagged, packed, or published by that workflow.
