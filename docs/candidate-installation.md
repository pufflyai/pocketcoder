# Candidate installation

CI produces candidate downloads for one full source commit. Choose a passing
`ci.yml` run. These artifacts expire under GitHub's retention policy. They do not
change a stable release, a `latest` tag, or the package registry.

## Supported targets

| System | CPU | Artifact suffix |
| --- | --- | --- |
| macOS | Apple Silicon | `darwin-arm64` |
| Linux | ARM64 | `linux-arm64` |
| Linux | x64 | `linux-x64` |

The standalone executable needs no Node, Bun, source checkout, external database,
or adjacent database files. Docker Engine must be running for controller
readiness and Docker workspaces. The executable contains the matching database
seed, engine, migrations, and server assets.

Follow the [standalone download and workspace round trip](getting-started.md#standalone-development-download).
It chooses the system and CPU, downloads a pinned executable and echo runtime,
checks the commit, platform, version and checksum, and runs from a new folder.
The same guide covers owner setup, preserve/resume, restart, and backup/restore.
Keep the owner key and backup outside all workspaces.

`native.json` records the commit, CLI version, target, byte count, SHA-256 checksum,
PGlite and PostgreSQL versions, seed and engine checksums, and migration hashes.
CI checks the executable's reported version and the database format in a real
backup against that record. It also enforces an executable of at most 90 MB,
controller peak memory of at most 512 MB, and readiness within four seconds.
The four-second startup allowance is temporary, approved on 5 November 2026;
PC-62 tracks the candidate qualification and follow-up.

## Public packages

The CLI and SDK packages require Node 22.19.0 or newer. Installed commands
run without Bun. The CLI package carries a native executable for each target in
the table. Its Node launcher selects the current target and forwards arguments
and stop signals. The SDK runs on Node.

Download the two tarballs from the same passing run used for the native binary:

```sh
gh run download "$PC_RUN" --repo pufflyai/pocketcoder \
  --name "pocketcoder-packages-$PC_COMMIT" --dir packages
test "$(jq -r .commit packages/packages.json)" = "$PC_COMMIT" || exit 1
test "$(jq -r .channel packages/packages.json)" = candidate || exit 1
jq -r '.packages[] | "\(.sha256)  \(.file)"' packages/packages.json > packages/SHA256SUMS
(cd packages && if command -v sha256sum >/dev/null; then
  sha256sum --check SHA256SUMS
else
  shasum -a 256 --check SHA256SUMS
fi) || exit 1
```

`packages.json` gives each tarball's name, version, bytes and checksum. The versions
come from that source commit; the artifact channel is `candidate`. No registry
publication is required. Install the tarballs in a new consumer using your Node
package manager. Pin both direct dependencies to their downloaded files. For
example, with the versions in the current source:

```json
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@pstdio/pocketcoder-cli": "file:./packages/pstdio-pocketcoder-cli-0.12.0.tgz",
    "@pstdio/pocketcoder-sdk": "file:./packages/pstdio-pocketcoder-sdk-0.8.0.tgz"
  }
}
```

Use the filenames in your downloaded record if the versions differ. After install:

```sh
node node_modules/.bin/pcd --version
node node_modules/.bin/pcd backup --help
node --input-type=module -e '
  import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
  console.log(typeof PocketCoderClient);
'
```

The CLI has no install dependencies, so it can also run directly from its tarball:

```sh
mkdir cli
tar -xzf packages/pstdio-pocketcoder-cli-0.12.0.tgz -C cli
node cli/package/dist/bin.js --help
```

## Reproduce the download checks

Contributor checks use Bun as the test runner and install tool. The tested
controller and installed commands have a PATH with no Bun executable.

```sh
bun run example:native:installed /path/to/downloaded-native "$PC_COMMIT"
bun run example:e2e:native -- --binary /path/to/downloaded-native/pocketcoder \
  --fixture /path/to/downloaded-fixture
bun run candidate:packages check /path/to/downloaded-packages "$PC_COMMIT"
```

CI runs native startup, owner setup, restart, backup/restore, TypeScript consumers,
SDK HTTP/WebSocket entry points, and CLI commands on all three native runners. It runs the Docker workspace preserve/resume flow on both Linux
runners. macOS uses Colima for its empty Docker daemon; Apple Silicon hosted
runners use cross-architecture QEMU without nested virtualization. Workspace
round trips can also run on a local macOS host with Docker.
The [Lima cross-architecture guide](https://lima-vm.io/docs/config/multi-arch/)
describes the QEMU and guest-agent requirements used by this CI setup.

Each `pocketcoder-installation-<commit>-<target>` artifact contains the validation
results. Container image publication belongs to PC-105. The combined release
manifest belongs to PC-62.
