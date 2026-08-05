# Security model

pocketcoder runs model-driven code in isolated workspaces. The security model
starts from one assumption: **anything a workspace can read will eventually be
read** — by the coding agent debugging itself, by code the agent writes, or by
a prompt-injected turn. Agents dump their environment into transcripts, and
transcripts are durable. Design so that none of this matters.

## The workspace is one trust zone

There is no security boundary *inside* a workspace. The harness, its plugins
and hooks, and every process the agent spawns share one uid, one filesystem,
and one environment — and harnesses load executable configuration (MCP server
definitions, hooks) from the workspace the agent writes to, so even a
harness-vs-tools split would not hold. Treat the whole workspace as a single
zone with the agent's authority, and place controls at its edges: the control
channel, the egress firewall, and the deployment's model gateway.

## Terminal access is template-owned

Interactive terminal access does not add caller-supplied command execution.
The immutable template selects one command, cwd, and environment; callers with
`terminal:attach` can only exchange PTY input, output, and resize messages
with that command. Use a separate `terminal:read` scope for session audit
metadata. PocketCoder records who opened a session, timestamps, exit status,
and byte counts, but never persists terminal content.

## Long-lived tokens are the failure mode

A leaked credential is an incident only if it outlives or out-scopes the place
it leaked from. The rule for every credential a workspace can read:

1. **One door** — it works against exactly one endpoint (e.g. the deployment's
   model gateway), nowhere else.
2. **No extra authority** — presenting it grants nothing beyond what the
   workspace's declared policy already allows.
3. **Dies with the workspace** — it expires or is revoked at teardown, so
   there is nothing to rotate after a compromise.

What this prevents is not hypothetical: given a standing gateway bearer in its
environment, a workspace agent has re-encoded an uploaded document as images
and POSTed them directly to the model endpoint — bypassing the harness's
text-only request path — and printed the bearer itself into the durable
transcript while debugging. Every part of that is ordinary agent behavior. The
only mistake was the credential's lifetime and scope.

Hiding a credential from the agent does not substitute for scoping it. A
supervisor that holds a hidden token and attaches it automatically hands the
agent the same authority with less friction — the channel is the capability,
not the token. Scope the channel; assume the token is public within the
workspace.

## Credential inventory

| Credential | Holder | Lifetime rule |
|------------|--------|---------------|
| Machine keys (`pcd keys issue`) | Operator backends, never workspaces | Prefer `--expires <ISO8601>` plus rotation; `--expires never` is for deliberate operational choices, not examples or ephemeral runs |
| Workspace registration secret | Supervisor | Single-use, spent at connect |
| Reconnect credential | Supervisor | Memory-only, never touches the workspace filesystem |
| Git/source credentials (`secretRef:`) | Workspace (read-only file) | Needed only during setup; keep the backing credential narrowly scoped and short-lived |
| Model gateway credential | Workspace | Per-workspace, minted at launch, dead at teardown — never a shared or standing bearer |

## Model access is a gateway concern

pocketcoder does not ship a model gateway; the deployment provides one (for
example [agentgateway](https://agentgateway.dev/)) and it is the only place
provider API keys exist. Because the workspace is one trust zone, the gateway
must not assume requests come from the harness — agent-written code can reach
it with the same credential. Enforce policy per *workspace identity* so that
this does not matter:

- allowed models, and modalities (reject image parts for text-only use — this
  alone blocks the document-exfiltration replay above);
- request size and rate limits;
- a hard token budget per workspace;
- per-request attribution and audit.

When the envelope is identical for every caller inside the workspace, direct
gateway use stops being an escalation: it is capability-equivalent to the
harness's own turns. That is the goal — make misuse worthless, not impossible.

The residual risk no gateway removes: data the model legitimately reads can
leave inside legitimate turns. Size, rate, and budget limits bound it; audit
exposes it; nothing eliminates it.

## Handling secrets a template needs

Classify by when the secret's authority is exercised, and by whom:

- **By the platform at launch** (clone credentials): deliver in memory over
  the control channel, consume during setup, gone before the harness starts —
  the same pattern launch input uses. Prefer this over any file mount.
- **By the platform on request** (a future push/publish flow): expose a
  narrow, policy-checked action the agent can invoke; the credential stays
  outside the workspace.
- **By agent code at runtime** (a database the code under test connects to):
  it cannot be hidden from the reader. Make the backing resource ephemeral and
  workspace-scoped instead, and revoke it at teardown.
