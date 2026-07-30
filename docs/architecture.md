# Architecture

```text
caller (machine key)
  → pocketcoder-server (Hono REST/WSS on Bun)
  → durable workspace queue (PostgreSQL)
  → workspace driver (Docker container or Kubernetes Job)
  → one isolated runtime per workspace
  → storage driver (host data roots or a Kubernetes PVC)
  → pocketcoder-agent (PID 1 supervisor)
  → harness (e.g. AgentAPI wrapping a coding-agent CLI)
```

There is exactly one execution path. Capacity pressure queues workspaces; it
never routes work to a shared process. Drivers are deployment configuration —
neither callers nor templates can select them.

## Components

| Component | Package | Responsibility |
|-----------|---------|----------------|
| pocketcoder-server | `apps/pocketcoder-server` | One Hono app: REST + OpenAPI, machine auth, agent WSS, relay; scheduler, outbox, reconciliation loops |
| pocketcoder-agent | `apps/pocketcoder-agent` | PID 1 in every workspace: registration, setup commands, harness supervision, health probes, log forwarding, relay execution, TERM/KILL |
| pocketcoderctl | `packages/cli` | Public bundled operator CLI: migrations, principals/keys, template validation, workspace inspection, doctor |
| contracts | `packages/contracts` | zod schemas: template v1alpha1, workspace states, WSS protocol frames, events, error codes |
| runtime-core | `packages/runtime-core` | Store contract, scheduler (admission/fairness/sweeps), template registry, outbox dispatcher, restart reconciliation |
| db | `packages/db` | PostgreSQL store, Drizzle schema and generated migrations under an advisory lock |
| drivers | `packages/drivers` | Docker/Kubernetes runtime drivers, filesystem/PVC checkpoint storage, file/Kubernetes secret resolvers |
| testkit | `packages/testkit` | In-memory store, fake driver, fake AgentAPI, template fixtures |

## Workspace state machine

```text
queued → provisioning → connected → ready ─┬→ terminating → succeeded|failed|canceled|expired
                                            └→ preserving → preserved
                                                                  │
                                                  restore checkpoint
                                                                  ↓
                                                     new queued workspace
```

- `queued → provisioning` happens under admission: fair round-robin across
  principals, FIFO within one, bounded by global/per-principal/per-template
  limits. Up to three infrastructure launch attempts may requeue — but only
  before a provider object exists; once a container ran, it is never
  relaunched automatically (the agent may have had external effects).
- `connected` requires redeeming the single-use registration secret and a
  matching template digest.
- `ready` requires every required template service healthy; the caller's
  launch input is erased at this point.
- Terminal states never reopen. Every transition commits atomically with its
  state-history row and a signed outbox event.
- Preservation stops the writer, snapshots only template-declared mounts,
  verifies an immutable manifest, and ends the source execution as
  `preserved`. Restore always allocates an independent writable copy and a
  fresh workspace/provider/credential lineage.

## Agent protocol

The supervisor opens one outbound WSS connection to `/v1/agent/connect` —
there is no inbound route into a workspace. First connection: one-time
registration secret; the ack delivers a reconnect credential (memory-only)
plus the exec spec (setup, harness, services, timeouts). Frames are JSON with
per-connection monotonic sequence numbers; the newest accepted connection
(epoch) exclusively speaks for the workspace.

Agent → server: `registered`, `heartbeat`, `process_state`, `service_health`,
`log_chunk`, `proxy_response`, `termination_ack`, `source_resolved`,
`checkpoint_status`, `restore_status`, `output_published`.
Server → agent: `registered_ack`, `proxy_request`, `signal`, `health_probe`,
`shutdown`, `prepare_checkpoint`.

There is no lease, arbitrary command execution, shell stream, tunnel, or file
API in the protocol. The relay forwards only template-declared loopback
routes with exact method/path/query/size/deadline checks.

Disconnects keep the workspace alive for the template's `disconnectGrace`;
after a server restart, nonterminal workspaces are reconciled against
labeled provider objects and supervisors simply reconnect.

## Security model

- Machine keys: named, scoped, digest-stored, instantly revocable, redacted
  from logs. No human accounts, sessions, or browser login.
- Templates are the only execution surface, and they are operator-deployed
  files — the API cannot introduce new images or commands.
- Workspaces: digest-pinned image, non-root uid, read-only root, tmpfs
  writes, dropped capabilities, no privilege escalation, no inbound network.
- Persistent paths are reviewed logical template declarations. Physical host
  paths, PVC subpaths, checkpoint locations, and mount flags never enter the
  public API. Checkpoints reject traversal, unsafe links, devices, sockets,
  FIFOs, setuid/setgid modes, integrity mismatch, and quota expansion.
- Git/model credentials are deployment-resolved read-only files under
  `/run/pocketcoder/secrets`; provider input and secrets are outside
  checkpointed paths.
- Launch input reaches the harness in memory; registration secrets are
  single-use; reconnect credentials never touch the workspace filesystem.
- Lifecycle events are HMAC-signed; consumers verify, deduplicate, and poll.
