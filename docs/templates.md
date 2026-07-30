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
		"harness": {
			"command": ["agentapi", "server", "--port", "3284", "--", "claude", "--dangerously-skip-permissions"],
			"cwd": "/home/agent/workspace",
			"env": { "ANTHROPIC_BASE_URL": "http://agentgateway.internal:8080" }
		},
		"env": { "HOME": "/home/agent" },
		"resources": { "cpu": "2", "memory": "2Gi" },
		"timeouts": { "start": "2m", "maxAge": "2h", "idle": "20m", "disconnectGrace": "5m", "terminateGrace": "15s" },
		"services": {
			"agent": {
				"baseUrl": "http://localhost:3284",
				"healthPath": "/status",
				"routes": [
					{ "method": "GET", "path": "/status", "maxResponseBytes": 65536 },
					{ "method": "GET", "path": "/messages", "query": ["after"], "maxResponseBytes": 1048576 },
					{ "method": "POST", "path": "/message", "maxRequestBytes": 65536, "maxResponseBytes": 65536 }
				]
			}
		},
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
  and harness changes need no image rebuild.
- **`setup`** — ordered commands run once before the harness starts (clone a
  repo, install dependencies, prime configuration). Each step has a name,
  timeout, optional env and cwd; output lands in workspace logs; a failing
  step fails the workspace with reason `setup_failed`/`child_exit_failure`.
- **`harness`** — the long-running conversation service supervised as one
  process group. Typically AgentAPI wrapping a coding-agent CLI (Claude Code,
  pi, aider, …), but anything that serves the declared loopback routes works.
  The caller's opaque `launch_input` is delivered to the harness in memory as
  `POCKETCODER_LAUNCH_INPUT`; the server erases its copy once the workspace is
  ready.
- **`services`** — the exact relay allowlist. Only declared method+path
  combinations (with declared query fields, size limits, and deadlines) are
  reachable via `/v1/workspaces/{id}/services/{service}/…`. `baseUrl` must be
  loopback. `required: true` services gate readiness on a healthy
  `healthPath`.
- **`timeouts`** — `start` (registration + first health), `maxAge` (hard
  lifetime), `idle` (no relay activity and agent not running), `disconnectGrace`
  (supervisor reconnect window), `terminateGrace` (TERM→KILL).
- **`security`** — non-root uid/gid (≥1000), read-only root, memory-backed
  writable paths, dropped capabilities, no privilege escalation. Values can
  only be stricter than the defaults, never weaker.

## Validation rules that will reject a template

- image not digest-pinned (`repo@sha256:<64 hex>` required);
- non-loopback service `baseUrl`, unnormalized route paths (`..`, `//`,
  query strings, encoded traversal);
- duplicate routes;
- env values that look like secret literals (names matching
  `SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL` must use a
  `secretRef:` reference resolved by the deployment);
- privileged security settings.

Check any file offline with `pcd templates validate <file>`.

## Persistence, source, and secrets

`persistence.mounts` opts a template into durable storage. Each mount has a
logical name, an absolute target, and byte/file ceilings. The server allocates
its physical backing; neither a caller nor a template supplies a host path,
PVC name, or backend. Mounts must be normalized, non-overlapping, outside
`/run/pocketcoder`, `/proc`, `/sys`, and `/dev`, and must not overlap tmpfs
paths.

```json
{
  "persistence": {
    "mounts": [
      { "name": "worktree", "target": "/workspace", "maxBytes": 10737418240, "maxFiles": 500000 },
      { "name": "agent-state", "target": "/state", "maxBytes": 1073741824, "maxFiles": 100000 }
    ],
    "conversationRestore": "supported",
    "sessionCompatibility": "agentapi-v1",
    "checkpoint": {
      "onIdle": "preserve",
      "onDeadline": "preserve",
      "onCleanExit": "preserve",
      "onFailure": "retain-for-recovery",
      "retention": "168h"
    }
  },
  "checkpointHook": {
    "command": ["/usr/local/bin/agentapi-checkpoint"],
    "timeoutSeconds": 30
  }
}
```

Setup steps default to `runOn: ["create"]`. Mark validation or repair steps
with `runOn: ["restore"]` when they are safe against restored content.
`conversationRestore: supported` requires a separate harness-state mount and
`sessionCompatibility`; otherwise use the honest `filesystem_only` default.
The optional checkpoint hook flushes application state before the runtime is
stopped.

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

## Writing workspace images

An image needs: the harness toolchain (e.g. AgentAPI installed by checksum
plus your agent CLI), the `pocketcoder-agent` binary or bundle, a passwd entry
for the template uid, and a working directory readable by that uid. See
[`deploy/image/Dockerfile`](../deploy/image/Dockerfile) for a minimal example
and the [deployment guide](deployment.md) for building and pinning.
