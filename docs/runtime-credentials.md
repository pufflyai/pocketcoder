# Renewable workspace credentials

A running agent can use an external resource through a workspace-scoped lease.
The controller keeps issuer authentication in its encrypted secret store.
The supervisor writes only the short-lived credential into private memory
storage. Use the protocol-v9 supervisor in your image.

## Configure an issuer

Run your own HTTPS issuer and resource service. PocketCoder does not include
a model gateway. Keep this operator file outside all workspace mounts:

```json
{
  "type": "runtime-issuer",
  "value": {
    "url": "https://issuer.example/runtime",
    "authorization": "Bearer <controller-only issuer key>",
    "policy": {
      "resources": ["https://gateway.example/models"],
      "models": ["approved-model"]
    }
  }
}
```

Publish it with `pocketcoder secrets put model-runtime --file
/operator/runtime-issuer.json`. The API and SDK accept the same typed request.
The operator needs `secrets:write`. Template publication also needs this scope
when the template names runtime issuers.

A runtime reference must resolve to a `runtime-issuer`. Setup issuers and
registry secrets cannot supply runtime authority. Issuer authentication,
provider keys, and registry credentials stay outside the workspace.
For a private CA, set `POCKETCODER_ISSUER_CA_FILE=/operator/issuer-ca.pem`
on the controller. Give the agent the resource service's public CA separately.
TLS verification stays enabled. Issuer redirects are rejected.

## Use a credential file

Add a reference to the template's `env`, `agent.env`, `harness.env`,
`terminal.env`, or `checkpointHook.env`:

```json
{
  "env": {
    "MODEL_CREDENTIAL_FILE": "secretRef:model-runtime",
    "MODEL_URL": "https://gateway.example/models"
  }
}
```

The supervisor replaces the reference with the path
`/run/pocketcoder/secrets/leases/model-runtime`. Read this file on each request;
its contents change during renewal. Do not read it once into a process-wide
bearer or copy it into a durable agent configuration. For example:

```ts
const credential = await Bun.file(process.env.MODEL_CREDENTIAL_FILE).text();
const reply = await fetch(process.env.MODEL_URL, {
  headers: { authorization: `Bearer ${credential}` },
});
```

Use a reviewed agent wrapper when a harness needs credentials in another form.
Publish the complete template with `pocketcoder templates import ./templates`,
then run `pocketcoder workspaces create --template <name> --wait`.
Setup environment references are not enabled; private Git uses the separate
[source setup flow](private-source.md).

## Issuer contract and lifecycle

Runtime requests use the [setup issuer contract](private-source.md) with
`purpose: "runtime-issuer"` and null `source_url` and `source_revision`.
The controller binds the immutable template, workspace, stored policy and
request ID. The issuer must enforce the policy's resources, workspace identity,
request digest and deadline. Each credential expires within five minutes or
the earlier workspace deadline. Repeated mint calls for one request ID return
the same lease, credential and expiry. Revoke permanently closes that request
ID, including a mint whose response was lost.

The supervisor asks for a new lease halfway through the current lifetime.
It retries a lost response with the same request ID and recorded issuer version, installs the replacement
atomically, and confirms installation before the controller revokes the old
lease. Reconnection replays pending leases. Expiry stops the agent if renewal
cannot finish. Passive renewal does not extend workspace idle time or deadlines.

Failed startup, preserve, purge, cancellation and termination fence new leases
and revoke outstanding authority. Cleanup stays pending until the issuer
acknowledges revocation or a recorded lease has expired. Preserve retries this
cleanup before it captures files. Canceling a waiting preserve settles its
operation after revocation and allows purge. Restore receives a new
workspace identity and fresh authority. Docker checkpoint restore uses the
existing HTTP archive flow; Kubernetes checkpoint restore is still unavailable.

Run `bun run test:runtime:live` with Docker, kubectl, kind, Git and OpenSSL.
It builds a disposable supervisor image and uses a local verified HTTPS issuer.
The agent's resource requests succeed before and after renewal on Docker and
Kubernetes. The fixture uses only synthetic data and removes its own cluster,
registry, image tag and temporary files.
