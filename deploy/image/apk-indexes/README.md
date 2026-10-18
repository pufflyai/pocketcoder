# Pinned Alpine indexes

These are the signed Alpine v3.24 main and community indexes used by the desktop
and browser images. Keeping their bytes here prevents unrelated repository
updates from breaking a reviewed build. The cache filenames come from apk and
depend on the repository URL and architecture. Do not rename them.

The current main revision is `v3.24.2-161-g9b53c2882fa`. The community revision
is `v3.24.2-155-g75e3be22c50`. Both architectures were downloaded with `apk update`
in the exact pinned Bun base, which verifies their repository signatures.
`SHA256SUMS` binds the copied bytes. Installation still verifies the signed
indexes and each downloaded package against the base image's trusted keys.

To refresh both architectures, run this from the repository root:

```sh
for arch in amd64 arm64; do
  docker run --rm --platform "linux/$arch" --user 0 \
    --mount "type=bind,source=$PWD/deploy/image/apk-indexes/$arch,target=/out" \
    oven/bun:1.4.3-alpine@sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373 \
    sh -ec 'apk update && cp /var/cache/apk/APKINDEX.*.tar.gz /out/ && cd /out && sha256sum APKINDEX.*.tar.gz > SHA256SUMS'
done
```

Review the printed revisions and changed hashes. Update the revisions above.
Run full image qualification on both architectures before merging. If the
repository URLs change, remove the old cache files before refreshing. Keep
exact desktop and Chromium version constraints in their recipes.
