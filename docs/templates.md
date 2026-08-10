# Templates

A template (`pocketcoder.dev/v1alpha1 Template`, JSON or YAML) is a reviewed,
versioned definition of a coding-agent environment. Templates are deployment
resources: operators put files in `POCKETCODER_TEMPLATE_DIR`, the server
validates and loads them at startup, and callers may only *select* an
authorized template by name/version. No API call can ever submit an image,
command, mount, network, privilege, or driver.

## Full example

```json
{
	"apiVersion": "pocketcoder.dev/v1alpha1",
	"kind": "Template",
	"metadata": {
		"name": "claude-code-agent",
		"description": "Claude Code behind AgentAPI with repository setup"
	},
	"spec": {
		"version": "1.0.0",
		"image": "registry.example/coding-agent@sha256:…",
		"command": ["/usr/local/bin/pocketcoder-agent", "supervise", "--launch-input", "/run/pocketcoder/input"],
		"setup": [
			{ "name": "clone-repo", "command": ["/usr/local/bin/clone-repo.sh"], "timeoutSeconds": 300 },
			{ "name": "install-deps", "command": ["bun", "install", "--frozen-lockfile"], "timeoutSeconds": 600 }
		],
		"agent": {
			"type": "claude",
			"transport": "pty",
			"termWidth": 120,
			"command": ["claude", "--dangerously-skip-permissions"],
			"cwd": "/home/agent/workspace",
			"env": { "ANTHROPIC_BASE_URL": "http://agentgateway.internal:8080" }
		},
		"terminal": {
			"command": ["/bin/sh"],
			"cwd": "/home/agent/workspace",
			"maxSessions": 2,
			"idleTimeout": "10m"
		},
		"env": { "HOME": "/home/agent" },
		"resources": { "cpu": "2", "memory": "2Gi" },
		"timeouts": { "start": "2m", "maxAge": "2h", "idle": "20m", "disconnectGrace": "5m", "terminateGrace": "15s" },
		"security": {
			"uid": 10001, "gid": 10001, "readOnlyRoot": true,
			"writableMemoryPaths": ["/tmp", "/home/agent"]
		}
	}
}
```

## The execution surface

- **`command`** — the container entrypoint: the `pocketcoder-agent` supervisor
  (PID 1, or a child of tini if your image sets one). It registers over
  outbound WSS and receives everything below at registration time, so setup
  and agent changes need no image rebuild.
- **`setup`** — ordered commands run once before the harness starts (clone a
  repo, install dependencies, prime configuration). Each step has a name,
  timeout, optional env and cwd; output lands in workspace logs; a failing
  step fails the workspace with reason `setup_failed`/`child_exit_failure`.
- **`agent`** — the coding-agent command, AgentAPI type, transport, cwd, and
  environment. `transport` defaults to `"pty"`; `"acp"` adds AgentAPI's
  `--experimental-acp` adapter for agents whose command speaks ACP. PocketCoder
  passes optional `termWidth` (10–65535) to AgentAPI only for PTY agents; it is
  rejected for ACP because ACP does not emulate a terminal. See the
  [transport decision](agent-transport-decision.md) for the cross-agent
  compatibility analysis. PocketCoder
  waits for AgentAPI's fixed status endpoint, synchronizes complete messages
  after `stable`, and terminates it safely for preserve. The caller's opaque
  `launch_input` is delivered to the process in memory as
  `POCKETCODER_LAUNCH_INPUT`; the server erases its copy once the workspace is
  ready.
- **legacy `harness` + `services`** — compatibility-only generic process and
  loopback relay declarations. They remain supported for one migration
  release and cannot appear beside `agent`. Each declared route may set
  `responseMode: "stream"` (default `"buffered"`) to relay a long-lived
  response such as SSE; `maxResponseBytes` then caps the cumulative stream and
  `deadlineSeconds` bounds its total lifetime. Streamed routes require a
  protocol-v5 supervisor.
- **`terminal`** — optional interactive PTY capability for native and legacy
  templates. `command` is the only command a caller can run; `cwd` and `env`
  are reviewed template values. `maxSessions` defaults to 2 (range 1–8) and
  `idleTimeout` defaults to `10m`. Sessions close before checkpoints and do
  not survive preserve/restore.
- **`timeouts`** — `start` (registration + first health), `maxAge` (hard
  lifetime), `idle` (no relay activity and agent not running), `disconnectGrace`
  (supervisor reconnect window), `terminateGrace` (TERM→KILL).
- **`security`** — non-root uid/gid (≥1000), read-only root, memory-backed
  writable paths, dropped capabilities, no privilege escalation. Values can
  only be stricter than the defaults, never weaker.

## Restricted outbound networking

Networking is unrestricted when `network` is omitted. A reviewed template can opt the whole
workspace—including setup, AgentAPI, tools, hooks, and MCP children—into default-deny egress:

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
- `agent.termWidth` outside 10–65535 or supplied with ACP transport;
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

Uploaded attachments live under `$HOME/.pcd/attachments` and are ephemeral by
default: they persist across preserve/restore only when a declared mount
contains the workspace user's `$HOME/.pcd` directory.

```json
{
  "persistence": {
    "mounts": [
      { "name": "worktree", "target": "/workspace", "maxBytes": 10737418240, "maxFiles": 500000 },
      { "name": "agent-state", "target": "/state", "maxBytes": 1073741824, "maxFiles": 100000 }
    ],
    "conversationRestore": "supported",
    "conversationRetention": "168h",
    "sessionCompatibility": "agentapi-v1",
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
For native `agent` templates the supervisor blocks new messages, waits for
AgentAPI to become stable, captures the final transcript, and terminates it
before snapshotting. Legacy templates may still provide `checkpointHook`.

`conversationRetention` controls how long the canonical display transcript is
readable after terminal state (default `168h`). It is separate from checkpoint
retention because callers may delete transcript content without deleting a
filesystem checkpoint. Native workspaces project complete AgentAPI messages
into the durable transcript using stable `agentapi:<id>` ids. Legacy harness
adapters may still write bounded `POCKETCODER_CONVERSATION <json>` lines to
stdout. Operational log text is never inferred into conversation history.

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
        "credential": "secretRef:git-credentials/token"
      }
    }
  }
}
```

The non-secret alias, revision, and resolved commit are durable provenance.
`secretRef:` values resolve to read-only files under
`/run/pocketcoder/secrets`; local deployments read files beneath
`POCKETCODER_SECRET_ROOT`, while Kubernetes interprets
`secretRef:<secret>/<key>`. Secret values and opaque launch input are never
checkpointed.

Template-declared outputs accept only bounded strings, Git SHAs, or HTTPS
URLs. A harness publishes one by writing a line such as
`POCKETCODER_OUTPUT {"name":"commit","value":"<sha>"}` to stdout.

## Immutability and versioning

`(name, version)` content is immutable: changing a file without bumping
`spec.version` is a startup error. Each workspace stores a full snapshot of
its template version, so template updates only affect workspaces created
afterwards. Removing a file from the template dir retires that version for
new workspaces without invalidating existing snapshots; putting it back
reactivates it. Omitting `version` at creation resolves the newest active
version once.

Use `pcd templates render` when a build must promote a source manifest to a
deployable immutable version. It replaces the placeholder image digest,
applies typed JSON-Pointer overrides, validates and normalizes the result, and
derives a deterministic version suffix from all deployable content:

```sh
pcd templates render templates/codex.yaml \
  --image "registry.example/codex@sha256:<64-hex-digest>" \
  --set '/spec/agent/termWidth=120' \
  --out deploy/templates
```

The source must use a plain release triplet such as `1.2.3`; the rendered
version is `1.2.3-<12-character-content-hash>`. The command writes canonical
JSON without modifying its source.

## Writing workspace images

An image needs checksum-pinned AgentAPI at `/usr/local/bin/agentapi`, your agent
CLI, the `pocketcoder-agent` binary or bundle, a passwd entry
for the template uid, and a working directory readable by that uid. See
[`deploy/image/Dockerfile`](../deploy/image/Dockerfile) for a minimal example
and the [deployment guide](deployment.md) for building and pinning.
