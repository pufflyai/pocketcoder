# Canonical workload templates

`pocketcoder.dev/v1` defines one workload contract. Operations select pinned
`process`, `service`, or `pi` adapters. An arbitrary process needs no
agent wrapper or credentials. Generic HTTP transport can use the `service`
profile with no operation adapters. That profile promises no request recovery or
cloud-interactive execution semantics.

The Docker controller admits `finite-process` workloads and authored `service`
workloads with request-aware `pocketcoder.execution/v1` adapters. Credential
slots remain closed. Service operations can declare output roots when the
installed runtime and adapter prove `explicit-publication` support. See the
[publication protocol](managed-session-work.md#adapter-result-publication).
Set `POCKETCODER_WORKLOAD_LIMITS` to a JSON object with the deployment's finite
workload ceilings, and configure [immutable input storage](input-storage.md).
Publication retains the complete canonical manifest. Startup checks the actual
image, runtime, adapter, read-only input mount and incarnation before readiness.
Cloud-interactive publication remains closed. Kubernetes has
no qualified canonical workload driver. Offline validation is not qualification.

Canonical waiting runtimes require workspace protocol 14. Older supervisors are
rejected before registration, so rebuild pinned images with the current supervisor.
The controller supplies `/run/pocketcoder/services` as private writable memory for
service control, including templates with a read-only root and no authored memory paths.

A service workload can declare `spec.lifecycle.persistence`, `checkpointHook`,
`timeouts` and `maxLaunchInputBytes`. These use the existing lifecycle owners.
They preserve state mounts, quiescing hooks and conversation restore without
creating an alpha agent or harness. Alpha snapshots retain their original bytes
and digests.

The image must contain `/opt/pocketcoder/workload.json`, with format
`pocketcoder.image/v1`. Its `runtime` records the measured supervisor artifact,
SHA-256 digest, protocol, exact container command and entrypoint. Each entry in
`adapters` records the service artifact, digest, protocol, exact command, working
directory, allowed environment keys, loopback base URL, health path and
capabilities. `codeRoots` lists the immutable directories containing runtime and
adapter code, including imported dependencies. Writable mounts and memory paths
cannot overlap those roots. Artifacts and their ancestors cannot be symlinks.
The driver hashes pristine image artifacts and the installed process-root bytes;
HTTP capability responses never substitute for this evidence.

The fixed runtime command is `/usr/local/bin/bun /opt/pocketcoder/supervisor.js
supervise --launch-input /run/pocketcoder/input`. The service process is image-owned
infrastructure. A user task starts only through the durable execution API.
For no-export service operations, a durable terminal acknowledgment closes input
publication, releases that operation's projection and finalizes its input pins.
The next request in the workspace waits for this barrier; with
`parallel-conversations` only the next request in the same conversation waits
(see [conversation identities](conversation-identities.md)). Replays retain the
original execution receipt and never redispatch a settled operation.

## Contract owners

| Contract | Owner |
| --- | --- |
| Manifest, adapters, operations and snapshots | `contracts/src/templates/workload-template.ts`, exposed through `template-schema.ts` |
| Installed image/runtime/adapter/storage identities and capabilities | `contracts/src/templates/workload-capabilities.ts`; driver-observed `ProviderState.workload` in `runtime-contracts/src/drivers/driver.ts` |
| Profile, pin, deadline and deployment ceiling checks | `contracts/src/templates/workload-admission.ts` |
| Accepted input objects and ordered manifests | `contracts/src/attachments/input-reference.ts` |
| Execution references, frozen acceptance fingerprints and cancellation | `contracts/src/workspaces/workload-operation.ts` |
| Immutable retained exports | `contracts/src/outputs/export-reference.ts` |
| Trusted policy references for expiring credentials | `contracts/src/secrets/credential-slot.ts` |

Paths in this table are under `packages/`. Process and conversation request owners
remain authoritative. The execution reference selects one of them; it creates no
second scheduler or universal mutable execution record. A driver that omits
`ProviderState.workload` advertises no canonical capabilities.

## Authoring and rendering

See the complete [credential-free finite process fixture](../examples/workloads/finite-process.json).
Its image, runtime and adapter hashes are test identities, not installed artifacts.
Resolve customization during the image build. Replace those pins with actual
immutable artifacts and render a new template version:

```sh
pcd templates validate examples/workloads/finite-process.json
pcd templates render examples/workloads/finite-process.json \
  --image 'registry.example/workload@sha256:<64-hex-digest>' \
  --set '/spec/runtime/digest="sha256:<64-hex-digest>"' \
  --set '/spec/adapters/main/digest="sha256:<64-hex-digest>"' \
  --out build/workloads
```

Render hashes all normalized deployable content except `spec.version`, including
the format, image, runtime, adapter pins, operations and limits. It produces the
same `1.0.0-<12-character-hash>` for identical content. Runtime inheritance and
caller-selected commands, mounts or adapters are not part of the contract.

A generic HTTP service can replace the fixture's profile and declarations with:

```json
{
  "profile": "service",
  "adapters": {},
  "operations": {},
  "services": {
    "api": {
      "baseUrl": "http://127.0.0.1:8080",
      "process": { "command": ["bun", "/app/service.ts"] },
      "routes": [{ "method": "POST", "path": "/work" }]
    }
  }
}
```

Native session producers use a `service` adapter with `pocketcoder.execution/v1`. See [native structured sessions](agent-transport-decision.md) for the image pins and canonical message contract.

## Admission and bounds

`workloadAdmission` requires trusted driver evidence for the exact image, template,
runtime and adapter pins, an observed workspace/incarnation, qualified durable
storage, a supported deployment profile, and a future `expiresAt`. Capability
requirements come from the profile and each operation. Every required operation
capability must be present in both the installed runtime and the selected producer.
A manifest declaration or installed package version alone proves nothing. A weak
producer's `workspace-cancel` or `unknown-outcome` cannot substitute for targeted
cancel or durable request lookup.

Finite process requires explicit start, exact exit/signal observation, targeted
cancel and stop-before-export. Cloud interactive requires deduplicated acceptance,
request lookup, targeted turn cancel, explicit publication, workspace-lived
services and revocable browser grants. Both require readiness without a task,
later immutable inputs, serial operations and retained exports. They use explicit
release and a finite deadline, with no automatic idle expiry.

Every template declares every `limits` field. There are no production defaults.
The fixture sets 1 MiB per input, 8 MiB staged input, 16 input files, 2 transfers,
4 MiB exports, 16 export files, 600 seconds unreferenced-input retention, 900
seconds export retention, a 600-second deadline and 30-second finalization budget.
Deployment ceilings cap every field. Missing, zero, unsafe, unbounded or excessive
values fail. A single input cannot exceed staged capacity; finalization cannot
exceed the workspace deadline. Retention remains independent of compute lifetime.

`credentialSlots` may be empty. A slot references a trusted, versioned control-plane
policy and either fixed scope or a post-create grant. Adapter or service-process
env uses `credentialSlot:<name>`; no standing secret is stored in the manifest.
Delivery is a workspace-scoped expiring file, bounded by both the slot lifetime
and the workspace's actual remaining lifetime. This schema does not implement
issuance or grants; the existing lease owner implements that later gate.

## Alpha runtime reference

The rest of this page describes the existing `v1alpha1` runtime. It is not a
translation of the canonical format. See [migration](migration.md) for deliberate
replacement and immutable snapshot support checks.

## Alpha template format

A template (`pocketcoder.dev/v1alpha1 Template`, JSON or YAML) is a reviewed,
versioned definition of a coding-agent environment. An operator with
`templates:write` and a matching name grant publishes it with
`pcd templates import <directory>` or `POST /v1/templates` using
`{ "manifest": <template> }`. Image references must be digest-pinned. Restricted-network publication requires
a configured `POCKETCODER_EGRESS_IMAGE`; otherwise the API rejects it before storage. Published
versions are immutable; identical content returns the existing version.
`DELETE /v1/templates/{name}/{version}` retires a version without changing
existing workspace snapshots. Retirement cannot be undone by republishing it.

Workspace callers select an authorized template by name/version. Workspace
creation never accepts arbitrary images, commands, mounts or privileges.
`POCKETCODER_TEMPLATE_DIR` remains an additive operator startup import option.
Removing a file does not retire its published version. Use the retirement API;
a startup file cannot reactivate an explicitly retired version. The local
HTTP echo path is described in [Getting started](getting-started.md).

## Private images

Store registry authority on the controller, then name it in a reviewed template.
The default `pocketcoder serve --dir ./pc_data` creates a private encryption key
under `pc_data/keys/secret-key`. Keep that folder outside all workspace mounts.
The HTTP API and CLI return secret metadata only.

Prepare a protected JSON file on the operator machine, outside workspace files:

```json
{
  "type": "registry",
  "value": {
    "server": "registry.example",
    "username": "operator",
    "password": "<registry-password>"
  }
}
```

With `POCKETCODER_URL` and `POCKETCODER_KEY` set for the controller:

```sh
pocketcoder secrets put private-image --file /operator/registry.json
pocketcoder templates render templates/agent.json \
  --image 'registry.example/agent@sha256:<64-hex-digest>' \
  --set '/spec/imagePullSecret="secretRef:private-image"' \
  --out /operator/templates
pocketcoder templates import /operator/templates
pocketcoder workspaces create --template <template-name> --wait --json
pocketcoder secrets list --json
pocketcoder secrets retire private-image
```

`secrets:write` or `admin` is required to store, list or retire a reference.
Publishing a template that uses it also requires that scope and the usual
`templates:write` and template name grant. Workspace callers need only their
normal template and workspace grants. Missing or retired references and a
registry host that differs from the image fail the launch. The image stays
pinned to its digest. Private templates use cold launches; warm pools reject them.
Retirement stops new pulls and does not stop an already running workspace.

Docker sends authentication directly to the selected local Unix socket. It
creates no pull configuration file and rejects remote Docker endpoints.
Kubernetes creates a pull Secret for the kubelet. It never mounts that Secret
in the workspace, and service account token mounting stays disabled. Registration,
failed launch, removal and purge delete the owned pull Secret. An interrupted
launch uses the same workspace name so later cleanup can remove its Secret.

Registry and setup issuer storage are enabled. See [private source setup](private-source.md)
for scoped source leases. Runtime issuer configuration remains unavailable until
its lease flow is implemented. A server configured
with an explicit authentication pepper also needs a controller-only
`POCKETCODER_SECRET_KEY` (32 bytes encoded as base64url) to enable secret storage.

Run the synthetic private-image echo flow with `bun run example:e2e:private-image`.
Run real Kubernetes pulls with `bun run test:kind:registry`; Bun, Docker, kubectl
and kind v0.33.0 must be installed. The command deletes its disposable cluster.

## Native sessions

Use a measured native service image and the `sessionTemplate` helper from the SDK. Supply the image digest, runtime digest, adapter digest, and the exact service command from its image descriptor.

The service accepts `input.message` and returns canonical message parts. See [native structured sessions](agent-transport-decision.md). Alpha templates remain available for ordinary processes and declared services. They do not wrap agent commands.

## Restricted outbound networking

Networking is unrestricted when `network` is omitted. A reviewed template can opt the whole
workspace—including setup, producers, tools, hooks, and MCP children—into default-deny egress:

```json
{
  "network": {
    "mode": "restricted",
    "allow": [
      { "domain": "github.com" },
      { "domain": "*.github.com", "ports": [443] },
      { "domain": "agentgateway.internal", "ports": [8080], "allowPrivate": true }
    ]
  }
}
```

Ports default to 80 and 443. Exact domains exclude subdomains; `*.example.com` includes
subdomains but excludes the apex. Lowercase ASCII DNS names are required, and an empty list is
deny-all. Private, loopback, link-local, and metadata resolutions require `allowPrivate: true` on
the matching reviewed rule. Restricted templates cannot declare proxy environment variables.

V1 supports HTTP and HTTPS CONNECT without TLS interception. It therefore cannot filter encrypted
HTTPS methods or paths, and it blocks SSH and other non-HTTP protocols.

## Validation rules that will reject a template

- image not digest-pinned (`repo@sha256:<64 hex>` required);
- both `agent` and any of `harness`, `services`, or `checkpointHook`;
- non-loopback service `baseUrl`, unnormalized route paths (`..`, `//`,
  query strings, encoded traversal);
- duplicate routes;
- terminal cwd traversal, invalid limits, or an empty command;
- `agent.interruptKeys` empty, longer than 16 characters, or supplied with ACP
  transport;
- env values that look like secret literals (names matching
  `SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL` must use a
  `secretRef:` reference resolved by the deployment);
- privileged security settings.
- invalid domains, IP literals, arbitrary wildcards, ports outside 1–65535, or proxy variables in
  a restricted template.

Check any file offline with `pcd templates validate <file>`.

## Persistence, source, and secrets

`persistence.mounts` opts a template into durable storage. Each mount has a
logical name, an absolute target, and byte/file ceilings. The server allocates
its physical backing; neither a caller nor a template supplies a host path,
PVC name, or backend. Mounts must be normalized, non-overlapping, outside
`/run/pocketcoder`, `/proc`, `/sys`, and `/dev`, and must not overlap tmpfs
paths.

Uploaded attachments use private controller storage; `$HOME` files and sidecars
are not canonical inputs. Docker execution selections are published read-only at
`/run/pocketcoder/inputs/<manifest-id>` when the deployment configures the
[daemon-host publisher](input-storage.md#docker-projection). Templates cannot
choose host paths or add mounts inside this root. Keep writable work and output
paths separate. Canonical staging and projection need explicit finite limits.
Legacy attachment-bearing relay remains unavailable until the operation owner
installs dispatch fencing (PC-129).

Workspace-local working files persist across preserve/restore only when their
directory lies under a declared persistence mount. Canonical input references are
not restored or silently rebound; stage new workspace-scoped IDs after restore.

```json
{
  "persistence": {
    "mounts": [
      { "name": "worktree", "target": "/workspace", "maxBytes": 10737418240, "maxFiles": 500000 },
      { "name": "agent-state", "target": "/state", "maxBytes": 1073741824, "maxFiles": 100000 }
    ],
    "conversationRestore": "supported",
    "conversationRetention": "168h",
    "sessionCompatibility": "native-session-v1",
    "checkpoint": {
      "onIdle": "preserve",
      "onDeadline": "preserve",
      "onCleanExit": "preserve",
      "onFailure": "retain-for-recovery",
      "retention": "168h"
    }
  }
}
```

Setup steps default to `runOn: ["create"]`. Mark validation or repair steps
with `runOn: ["restore"]` when they are safe against restored content.
`conversationRestore: supported` requires a separate harness-state mount and
`sessionCompatibility`; otherwise use the honest `filesystem_only` default.
Native service templates persist the producer journal and agent context beneath declared mounts. Their image-owned checkpoint hook fences accepted work before capture.

`conversationRetention` controls how long a conversation stays readable after
the last workspace that wrote to it ends (default `168h`). Servers may cap or
replace it (see [conversation history](conversation-identities.md#durable-conversation-history)).
It is separate from checkpoint retention because callers may delete
conversations without deleting a filesystem checkpoint. Native service observations carry canonical messages and parts. Plain operational logs never become conversation history.

`artifacts` declares private files that the harness writes into a persisted
mount, such as per-chat diagnostic transcripts. The control plane reads them from
the latest ready checkpoint of a preserved workspace, without resuming it:

```json
"artifacts": [
  { "name": "chat-transcripts", "mount": "harness-state", "pattern": "chats/*/transcript.jsonl", "maxBytes": 8388608 }
]
```

```text
GET /v1/workspaces/{id}/artifacts/{name}?key=<chat>   scope workspaces:read   application/octet-stream
```

The `key` fills the pattern's single `*` segment. Unknown names, keys outside
the pattern, links, missing files and expired checkpoints return
`404 artifact.not_found`; a file above `maxBytes` (default 8 MiB, at most
64 MiB) returns `413`. While the workspace runs, the route returns
`409 artifact.workspace_active`: read the live file through the harness's own
relay route. PocketCoder neither parses nor displays artifacts, and they are
never a source of conversation history. `artifacts` is optional, so templates
without it keep their digest.

Cooperative Stop and shutdown perform a fresh transcript read before TERM,
within the existing termination grace period. Read failures are reported and
termination continues. KILL skips that read. A disconnected control channel
or forced kill can still prevent delivery of the latest input.

A template may define repository aliases under `source.repositories`. The
caller selects only an alias and validated revision:

```json
{
  "source": {
    "kind": "git",
    "destinationMount": "worktree",
    "repositories": {
      "app": {
        "url": "https://github.com/example/app.git",
        "credential": "secretRef:private-source"
      }
    }
  }
}
```

The non-secret alias, revision, and resolved commit are durable provenance.
The repository reference names a stored `setup-issuer`. At registration the
controller requests a bounded workspace lease over HTTPS. Create-time setup
receives it in `POCKETCODER_SOURCE`. The supervisor clears the value and waits
for issuer revocation before the harness starts. See the [private-source
recipe](private-source.md). Source credentials are never read from deployment
files or Kubernetes Secrets. Publishing their references also requires
`secrets:write`.

Other `secretRef:` environment values still resolve to read-only files under
`/run/pocketcoder/secrets` for agent code that needs a runtime credential. Such
credentials must be workspace-scoped and expire with the workspace.

Template-declared outputs accept only bounded strings, Git SHAs, or HTTPS
URLs. A harness publishes one by writing a line such as
`POCKETCODER_OUTPUT {"name":"commit","value":"<sha>"}` to stdout.

## Immutability and versioning

`(name, version)` content is immutable: changing a file without bumping
`spec.version` is a startup error. Each workspace stores a full snapshot of
its template version, so template updates only affect workspaces created
afterwards. Startup imports are additive. Removing a file leaves its published
version available. Retire a version with `DELETE /v1/templates/{name}/{version}`
or the SDK's `templates.retire(name, version)`; existing snapshots stay valid.
Restoring a file or republishing identical content cannot reactivate a retired
version. Publish a new version instead. Omitting `version` at creation resolves
the newest active version once.

A preserved workspace keeps its checkpoint's version when it is restored. To
move it onto a new version, pass `template_version` to restore, recreate or
resume (`--template-version` in `pcd`). The new version must keep the same
session format, mounts (names and targets, with limits that do not shrink) and
file owner, and the same `agent.stateFile`. See
[restore onto a newer template version](checkpoint-api.md#restore-onto-a-newer-template-version).

Use `pcd templates render` when a build must promote a source manifest to a
deployable immutable version. It replaces the placeholder image digest,
applies typed JSON-Pointer overrides, validates and normalizes the result, and
derives a deterministic version suffix from all deployable content:

```sh
pcd templates render templates/codex.yaml \
  --image "registry.example/codex@sha256:<64-hex-digest>" \
  --out deploy/templates
```

The source must use a plain release triplet such as `1.2.3`; the rendered
version is `1.2.3-<12-character-content-hash>`. The command writes canonical
JSON without modifying its source.

## Writing workspace images

A native session image needs the supervisor, its producer, and its measured workload descriptor. The bundled image supplies echo. The Pi and Onefin images use Pi JSON RPC. See [native structured sessions](agent-transport-decision.md).

### Web previews

Declare each webapp port in the immutable template. These ports are separate from
the session producer and other platform services. The app must listen inside the workspace.

```json
"previews": {
  "web": { "port": 3000 }
}
```

Names start with a lowercase letter and contain at most 20 lowercase letters,
numbers or hyphens. `display` and `pc-*` names are reserved. Ports must be between
1024 and 65535; Session, VNC, display and debugging ports are reserved.

A caller with `previews:open` and current ownership can mint a browser URL.
Each workspace and preview has its own full UUID hostname under `.localhost`.
Local previews require an HTTP controller on loopback. Hosted top-level and
embedded views use the configured isolated public-view origin. Cloud opens
require a durable grant; see [preview grants](preview-grants.md).

The one-time URL expires after 60 seconds. Opening it creates a host-only,
HttpOnly, SameSite=Lax cookie and redirects to `/` before serving workspace HTML.
Local browser sessions last at most one hour, the issuing key's remaining
lifetime, and the workspace deadline. Cloud sessions are also capped by their
grant, initially at most 60 seconds. Permission loss, revocation or workspace shutdown
closes active streams. A controller restart requires a fresh URL.

HTTP assets, relative redirects and WebSockets use the supervisor's existing
outbound connection. Unsafe methods and WebSocket upgrades require the exact
preview Origin. Platform headers and cookies are removed before relay. App
cookies stay on their preview host; reserved names and Domain cookies are dropped.
Passive requests and live reload do not refresh workspace idle time.

Requests and WebSocket messages are capped at 64 KiB. HTTP responses are streamed
with acknowledgements, capped at 16 MiB and five minutes. WebSocket queues share
an 8 MiB budget and close stalled peers after 30 seconds. Admission allows at most
32 streams per preview, 64 per workspace and 128 per controller; the existing HTTP
relay may impose a lower workspace limit.
# Desktop display

Build the workspace base image, then build `deploy/image/desktop.Dockerfile` with
that image as `BASE_IMAGE`. The standard desktop adds Xvfb, openbox, xterm and
x11vnc. It runs as uid 10001. X and VNC accept loopback connections only.

Use `examples/templates/desktop.json`. Replace its sample digest with the built
image digest before importing it. `display: { "mode": "desktop" }` declares the
fixed VNC endpoint. It cannot be exposed through a preview or forwarding port.
The harness wrapper starts the desktop before its template-owned agent command.
For a coding agent, use a native session service template.

Open a trusted viewer with
`pocketcoder workspaces display --id <workspace> --open`. `display:view` permits
watching. Add `--control` and `display:control` for keyboard and pointer input.
One controller and at most five streams may share a desktop. Clipboard and
unsupported VNC extensions are disabled. The server checks input even when a
caller forges the viewer's view-only setting. Revocation, grant loss, expiry and
workspace shutdown close the stream. Watching does not extend idle lifetime.

The viewer bundles noVNC 1.7.0 under MPL-2.0, with its source URL, author list and
dependency notices served at `/license`. Run `bun run viewer:build` after editing
the viewer source. `bun run check` checks the generated bundle and notices.
Run `bun run example:e2e:desktop` for the real Docker round trip; add `-- --browser`
to leave a fresh URL open for a browser check. The recipe checks the image is
under 1.5 GB and removes the owned runtime when it ends.
# Browser display

Build the base workspace image, then build `deploy/image/browser.Dockerfile`.
Use `examples/templates/browser.json` and replace its image placeholder with the
actual digest. The image runs Chromium as UID 10001. Its profile and temporary
files use the workspace's bounded `/tmp`. CDP listens only on `127.0.0.1:9222`.
The browser and agent processes stop when the workspace ends.

Declare `display: { mode: "browser" }` in the immutable template. The browser
viewport is 1280 by 800. Use `pocketcoder workspaces display --id <id> --open`
to view it, or add `--control` to navigate, click and type. Viewing requires
`display:view`; control also requires `display:control`.

The viewer controls one page. New tabs and popup windows have no selection
control. Use the navigation action to open a link in the controlled page.

Browser control accepts only these actions: HTTP/HTTPS navigation without URL
credentials, a left click, up to 1024 characters of text, a bounded vertical
scroll, and Enter, Tab, Backspace, Delete, Escape, arrow, Home, End and Page keys.
Raw CDP, arbitrary method names and JavaScript evaluation are rejected. Each
display allows five viewers and one controller. Frames update at most 15 times
per second. Large images use bounded chunks; a slow viewer cannot hold Chromium
frame acknowledgements or agent traffic.

Run `bun run example:e2e:browser` with Docker running to check real navigation,
detailed frames, input, permission denial, expiry, reconnect and cleanup.


## Workspace-lived websites

A canonical workload can declare a reviewed service process and leave it stopped
until a tool starts it. For example, add this entry under `spec.services`:

```json
"website": {
  "baseUrl": "http://127.0.0.1:3000",
  "healthPath": "/",
  "routes": [{ "method": "GET", "path": "/" }],
  "required": false,
  "autostart": false,
  "process": {
    "command": ["/usr/local/bin/bun", "run", "website"],
    "cwd": "/workspace",
    "env": {}
  }
}
```

The reviewed script may serve workload-authored files from an allowed writable
root. Preview traffic needs a declared preview port matching the website listener.
Ports used by execution adapters remain private and cannot also be preview ports. A manual service cannot block initial readiness.

The supervisor provides this workspace-local tool recipe:

```sh
pocketcoder-supervisor service start website <stable-start-uuid>
pocketcoder-supervisor service status website
pocketcoder-supervisor service stop website
```

The control socket comes from `POCKETCODER_SERVICES_SOCKET`. Start accepts only
the declared service name and a stable UUID. It cannot select a command, secret,
environment or port. Repeating that ID returns the saved start receipt. Using it
for another service conflicts. Status reports process state separately from HTTP
listener health. After observed exit, a new ID may start one new attempt. Unknown
outcomes must be stopped and reconciled before restart. There is no restart loop.

Task completion and targeted cancel stop the task group and leave workspace
services alive. Workspace release, finite-job finalization and hard expiry stop
all owned groups before extraction. Detached processes outside those groups have
no continuity guarantee. A replacement workspace starts new service processes.

Canonical runtimes do not use agent-idle observations to expire a workspace.
Every workspace still has a hard deadline. At creation, the controller stores a
ceiling from the smaller template and deployment maximum. A shorter initial
`spec.lifecycle.timeouts.maxAge` leaves room for an authorized extension. Read
`lifetime.revision` and `lifetime.ceilingAt` from the workspace resource, then use
[the lifetime route](api.md#workspace-lifetime-extension). It locks the same row
as teardown and keeps a receipt for each extension ID. Browser traffic, uploads,
reconnects and live reload never extend lifetime. Extending a workspace does not
extend previously issued credentials or browser grants.

See [finite exports](finite-exports.md) for output ownership and cleanup.
