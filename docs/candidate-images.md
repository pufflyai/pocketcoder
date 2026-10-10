# Candidate images

PC-105 builds six image roles from one source commit for Linux amd64 and arm64.
The workflow runs each architecture on a native runner. Local amd64 emulation
helps find defects but does not replace native acceptance.

| Role | Recipe | Supported work |
| --- | --- | --- |
| server | `deploy/image/server.Dockerfile` | Controller, public `pocketcoder` CLI, Docker and Kubernetes drivers |
| workspace | `deploy/image/Dockerfile` | Supervisor, native AgentAPI, echo harness, checkpoint upload and restore |
| desktop | `deploy/image/desktop.Dockerfile` | Workspace plus authenticated desktop viewer |
| browser | `deploy/image/browser.Dockerfile` | Workspace plus authenticated browser viewer |
| egress | `packages/egress/Dockerfile` | Restricted-network proxy for both drivers |
| manager | `deploy/image/manager.Dockerfile` | Private account database, finite owner bootstrap and account reconciliation |

Real agent images extend the workspace image and install the reviewed agent
and its application tools. These probe images do not install every agent CLI.

## Build and test

Start from a clean checkout of the final commit. Install dependencies with
`bun install --frozen-lockfile`. Docker, Kind 0.33.0, host kubectl 1.34 through
1.36 (the workflow pins 1.35.9), and Trivy 0.74.0
must be available. Use a disposable machine with enough space for the image
archives and the two-node Kubernetes fixture.

```sh
commit=$(git rev-parse HEAD)
bun run images:candidate out/candidate-images "$commit" arm64
bun run images:smoke out/candidate-images "$commit" arm64
```

Use `amd64` on an amd64 machine. The smoke command refuses a different host
architecture. The build command refuses tracked or untracked source changes.
Generated output stays ignored. It records the source Bun version separately
from the Bun version installed inside each image.

Builds retain a Docker archive and its SHA-256 checksum for each role. Scans
consume that archive. Smoke flows use its loaded image ID. Publication loads
the same archive and checks its configuration digest again. Docker image IDs
can identify an OCI index or a configuration, depending on the image store;
the archive checksum and configuration digest bind the portable identity.
Kind checks each node's loaded configuration against that digest. It never rebuilds a role
between scan, smoke and publication.

The controller checks the existing three-second readiness and 512 MB memory
budgets. The desktop image must stay below 1.5 GB. The smoke runs real native
AgentAPI requests through both native and containerized controllers, real
filesystem and checkpoint security tests, authenticated desktop and browser
viewers, and the existing Docker and Kubernetes egress conformance tests.
The manager provisions two accounts through its HTTP API, claims finite owner
keys, proves account isolation, and keeps its inventory across restart.
Its sampler must record physical private-volume bytes. The server image ships
GNU `du` with authentic Debian package metadata and copyright. A real sparse-file
and hard-link probe checks its allocated-byte semantics before managed sampling.

The server image's public `pocketcoder` command is a bundled script that uses
the image's shared GNU Bun runtime. Its absolute shebang works without a shell
or `env`. The image record retains the script size and runtime version. Smoke
checks direct service startup, finite owner bootstrap and a clean SIGTERM exit.
The separately distributed native executable still has the 90 MB size cap;
the smoke checks its size before running its controller callback.

The Kind 0.33.0 fixture uses Kubernetes 1.35.0 nodes. The rebuilt kubectl 1.35.9 client
supports API servers 1.34 through 1.36 under Kubernetes' one-minor version-skew
policy. The separate existing fixture with Kubernetes 1.37 nodes stays unchanged; passing it
would not establish supported skew for this image client. The saved cloud
plan is not changed by candidate smoke.

Temporary controller keys, manager keys and Kubernetes service-account tokens
have explicit expiry. Fixtures keep manager cluster authority outside account
controllers and workspaces. Cleanup removes the containers, private volumes,
port forwards and Kind cluster created by the smoke.

## Release scan policy

Every role on both architectures must have zero HIGH and CRITICAL findings,
including findings without an upstream fix. The scanner checks operating
system and application packages. It does not accept ignore files, ignored
statuses or `ignore-unfixed`. It uses explicit policy arguments and does not
inherit scanner policy from a developer's environment.

The workspace roles keep Alpine display packages and an isolated pinned
Debian glibc runtime for Bun's native checkpoint functions. Trivy chooses one
operating system per image, so the gate also exports `/opt/glibc` from each
exact final image and scans those bytes as a Debian root filesystem. It
retains that archive checksum, Debian scan, SBOM and database metadata beside
the Alpine image scan. Publication evaluates both scans. A missing Debian
required native-library package record or Debian OS match fails the gate.

Each role record retains the source commit, architecture, image ID, size,
base/tool labels, archive checksum, scan, CycloneDX SBOM and scanner metadata.
The metadata includes the scanner version and vulnerability database update
time. The smoke report records all tested image IDs and archive checksums,
and hashes each command log. A role is `scanned` after a passing scan and
`passed` only after all role smoke completes.

Pinned Bun, Go, AgentAPI source, base-image and Kubernetes source references
are in the recipes. AgentAPI is rebuilt from the signed v0.12.2 source with
the patched Go and x/text versions, including its embedded chat UI. kubectl
is rebuilt from the pinned 1.35.9 source with patched Go and x/net. Signed
Alpine package index hashes prevent desktop or browser dependencies from
silently changing between builds. A changed repository index requires a
reviewed pin update and fresh scans.

LibVNCServer 0.9.15 scans up to its process file-descriptor limit before accepting
a viewer. Kind can supply a limit above one billion. The desktop harness bounds
only x11vnc's soft limit to 1024; the agent keeps its original limits. The same
authenticated viewer deadline and five-viewer limit apply on both drivers.

## Candidate publication

The image workflow runs on pull requests for validation and on manual dispatch
for candidate publication. Dispatch the committed feature ref:

```sh
gh workflow run images.yml --ref feature/pc-105-scanned-candidate-images
```

The publication job needs the repository gates and both native image jobs to
pass. Only that job can write packages. Before its first registry write, it
checks the complete twelve-image set and the checksums and identities of all
scan, SBOM, scanner, archive and smoke evidence.

It writes only `candidate-<full-source-commit>-<architecture>` and
`candidate-<full-source-commit>` tags under `ghcr.io/<owner>/<repo>/<role>`.
It does not write stable, latest or version tags, update release notes, or
promote a candidate automatically. Tags are discovery handles. Install using
the immutable `repo@sha256:...` values in the workflow's `published.json`
artifact. That file retains each architecture digest, its tested source image
ID, and the dual-architecture index digest for every role.

Registry read credentials stay outside workspaces. Use a finite operator or
CI credential when the repository is private. Never include registry or
manager credentials in templates, launch input, image layers or reports.
