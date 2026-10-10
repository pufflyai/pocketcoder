# Local managed accounts

The private manager creates one controller, namespace and PGlite volume per
account. It stores account intent and operation status in its own private data
folder. Its schema and seed are separate from the controller database. Both
reject the other application's data folder. One writer holds the manager lock.

Use a cluster with enforced Calico policies, a default ReadWriteOnce storage
class, and the chosen RuntimeClass installed. The manager checks these
prerequisites. It does not fall back to another runtime or an unenforced network.

Run the real two-account example from the repository root:

```sh
bun run example:e2e:managed-accounts
```

It creates an owned two-node kind cluster, installs pinned Calico, and builds the
controller and echo images. It tests interrupted creation, owner claim and
replacement, template publication, echo, private volumes, quotas, network denial
and RBAC denial. It removes its cluster and images afterward. Docker, kind and
kubectl must be available. The fixture uses `pc-runc` for synthetic tests; it does
not prove a production gVisor cell.

For a separate local cluster, set these host-side variables. Use an exact
controller image digest and a finite manager kubeconfig. Keep the kubeconfig and
data folder outside every workspace.

```sh
export KUBECONFIG=/private/operator/finite-manager-kubeconfig
export POCKETCODER_MANAGER_DIR=/private/operator/manager_data
export POCKETCODER_MANAGER_CONTROLLER_IMAGE=registry.example/controller@sha256:YOUR_DIGEST
export POCKETCODER_MANAGER_RUNTIME_CLASS=YOUR_RUNTIME_CLASS
# Optional: POCKETCODER_MANAGER_STORAGE_CLASS
bun run manager:start operator YOUR_ISO_EXPIRY
bun run manager:start
```

The first command prints an operator token once. Expiry is mandatory, in the
future, and at most 24 hours away. The database stores its digest. Set
`OPERATOR_TOKEN` to that finite token in the host shell. The listener defaults to
`127.0.0.1:8092`; `POCKETCODER_MANAGER_HTTP` sets another host and port.

```sh
curl -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: local-account-one' \
  -d '{"name":"local account"}' http://127.0.0.1:8092/v1/accounts
```

Poll `GET /v1/operations/{operation.id}` from the response until `succeeded`.
Provisioning errors leave the operation running with `provisioning_retry`; the
manager retries the same record. Repeating create returns the same account and
operation after a restart. Changed input with the same request ID returns 409.
Existing Kubernetes objects with another account identity are refused.

`GET /v1/accounts` lists accounts. `GET /v1/accounts/{id}` returns one account.
All requests need current finite operator authority. Bodies are limited to
8 KiB. Responses are private and must not be cached.

Once ready, call `POST /v1/accounts/{id}/owner` with
`{"request_id":"YOUR_UUID","expires_at":"YOUR_ISO_EXPIRY"}`. The expiry cannot
exceed current operator expiry or 24 hours. Owner plaintext is returned once.
Use it through a host-side port-forward to the account's `controller` Service on
8090 with the existing template and workspace APIs.

After a lost response, repeat the exact request ID and input. The controller
reconciles issuance and returns key metadata with `token: null`. To obtain a new
token, send a new request ID and `replaces_request_id` matching the old request.
Replacement revokes the earlier key. An uncertain pending request must first be
reconciled or expire. No plaintext is saved in the manager database and no
bootstrap Secret is mounted in a workspace.

Each account has a private 10 GiB controller PVC, namespace quota, controller and
workspace service accounts, and default-deny policies. Cold and warm workspaces
can reach their own AgentAPI, DNS and public HTTPS. They cannot reach operator
APIs or another account. Controller RBAC cannot read another account's Secrets or
launch jobs there. Workspaces receive no Kubernetes token or controller volume.

Production layout, gVisor, encrypted account/manager backups and customer
enablement belong to the following hosted-service tickets.
