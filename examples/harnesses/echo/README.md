# Echo harness

This is the deterministic PocketCoder harness example. The workspace image in
[`deploy/image`](../../../deploy/image/) contains the implementation at
`/opt/pocketcoder/echo-harness.ts`; this directory owns the reviewed template
used by the examples runner.

Run the complete local path from the repository root:

```sh
bun run example:e2e:local
```

The checked-in template uses a syntactically valid placeholder image digest.
The local runner builds the image and writes a generated copy of the template
pinned to Docker's local content-addressed image ID. Do not deploy the
placeholder directly.
