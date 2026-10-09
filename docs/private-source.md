# Private source setup

A workspace can clone a private repository with a short-lived setup lease.
The controller stores issuer authentication outside the workspace. It sends
only the scoped credential to create-time setup, then revokes it before the
agent starts. Use the protocol-v8 supervisor in your image.

## Configure an issuer

Run an HTTPS issuer that can mint and revoke source credentials. Store this
configuration in a protected operator file outside every workspace mount:

```json
{
  "type": "setup-issuer",
  "value": {
    "url": "https://issuer.example/setup",
    "authorization": "Bearer <controller-only issuer key>",
    "policy": { "repositories": ["https://git.example/team/app.git"] }
  }
}
```

Publish it through the operator API or CLI. Responses contain metadata only.
The caller needs `secrets:write` and the usual template grants.

```sh
pocketcoder secrets put private-source --file /operator/setup-issuer.json
```

For a private CA, start the controller with
`POCKETCODER_ISSUER_CA_FILE=/operator/issuer-ca.pem`. TLS verification stays on.
The stored URL fixes the issuer destination. Redirects are rejected.

The issuer receives `operation` (`mint` or `revoke`), `workspace_id`,
`template_digest`, `source_url`, `source_revision`, `request_id`,
`request_digest`, `policy_digest`, `purpose`, `expires_at` and `policy`.
It must enforce its approved repositories and workspace identity. A mint reply
echoes that identity and policy, with `lease_id`, `credential` and an
`expires_at` no later than the requested deadline. The deadline is at most
five minutes and never later than the workspace deadline.

Repeat mint requests must return the same lease and expiry. Revoke must create
a permanent request-ID tombstone, even if mint is still in flight or its reply
was lost. Its reply echoes the requested identity and adds `revoked: true`.
Never issue again for a revoked request ID. Persist both leases and tombstones
in the issuer. PocketCoder retains the original encrypted issuer version for
cleanup after configuration changes.

## Clone during setup

Install Git and this reviewed script at `/opt/private-source.ts` in your image.
This example assumes the issuer returns a Git bearer credential. Keep Git's
normal HTTPS certificate checks enabled.

```ts
const source = JSON.parse(process.env.POCKETCODER_SOURCE ?? "null");
const git = Bun.spawn([
  "git", "clone", "--branch", source.revision, source.url, source.destination,
], {
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${source.credential}`,
  },
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await git.exited);
```

Add these fields to a template with your digest-pinned image and agent command:

```json
{
  "setup": [{
    "name": "clone",
    "command": ["bun", "/opt/private-source.ts"],
    "timeoutSeconds": 120,
    "runOn": ["create"]
  }],
  "resources": { "cpu": "1", "memory": "512Mi", "ephemeralStorage": "256Mi" },
  "persistence": { "mounts": [{
    "name": "worktree", "target": "/worktree",
    "maxBytes": 67108864, "maxFiles": 10000
  }] },
  "source": {
    "kind": "git", "destinationMount": "worktree",
    "repositories": { "app": {
      "url": "https://git.example/team/app.git",
      "credential": "secretRef:private-source"
    } }
  }
}
```

Publish the full template with `pocketcoder templates import ./templates`.
Start it with `pocketcoder workspaces create --template <name> --source app
--revision main --wait`. Docker uses bounded workspace mounts. A source-only
Kubernetes launch uses bounded `emptyDir` with matching storage requests and
limits. Kubernetes checkpoint restore remains unavailable in this flow.

Setup expiry kills the setup process group. A failed setup, lost mint reply or
issuer outage leaves a durable cleanup request. Cleanup retries by its original
request ID. The workspace stays unfinished until revocation is acknowledged or
an acknowledged lease has proven expiry. Agent readiness also checks this in
the database. A saved copy of the setup credential has no authority after this
barrier. Runtime issuer credentials are not supported by this slice.

Run `bun run test:source:live` for real Docker and kind Git clones with a local
HTTPS issuer. The fixture uses HTTP Git only for synthetic data on the local
test network and verifies that a captured credential fails before agent startup.
