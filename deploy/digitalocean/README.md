# DigitalOcean Kubernetes example

Run one controller with embedded PGlite and checkpoint archives on its own
`do-block-storage` volume. Workspace Jobs use bounded `emptyDir` mounts. They
never mount the controller volume. No shared workspace storage is required.

This is a synthetic deployment recipe. Hosted gVisor and production recovery
acceptance are tracked in PC-84 and the later hosted tickets.

The [PC-84 pilot plan](pilot/README.md) contains the separate cluster scope,
current cost estimate, approval boundary and remaining hosted validation.

## Prepare the deployment

Use a DOKS cluster with enough CPU, memory and ephemeral storage for the declared
workspace limits. Install the selected RuntimeClass handler on the workspace
node pool. Set `POCKETCODER_KUBERNETES_RUNTIME_CLASS` in the deployment patch;
PocketCoder requests that exact class without a fallback.

Build and publish immutable server and workspace images. Replace every
`REPLACE_` image and model field in `server`, `bootstrap` and `pi-gateway`.
The persistent echo and Pi template examples include pod storage budgets. Keep
mount limits plus at least 64 MiB for the writable layer and logs within each
budget. Transfer staging also needs enough workspace memory.

Render the storage and server resources:

```sh
kubectl apply -k deploy/digitalocean/storage
kubectl kustomize deploy/digitalocean/server > /tmp/pocketcoder-server.yaml
kubectl kustomize deploy/digitalocean/bootstrap > /tmp/pocketcoder-admin.yaml
bun run example:digitalocean:check /tmp/pocketcoder-server.yaml /tmp/pocketcoder-admin.yaml
kubectl apply -f /tmp/pocketcoder-server.yaml
kubectl -n pocketcoder rollout status deployment/pocketcoder-server
```

The private controller generates and stores its keys once. Its data and deletion
journal stay on the private block volume. Never mount that volume in a workspace.
Run one controller replica with the Recreate strategy. A block volume does not
replace the controller writer lock. Fence a failed node before moving its volume.

## Claim finite owner authority

After the controller is ready, use its local administration socket through an
operator-only `kubectl exec`:

```sh
kubectl -n pocketcoder exec deployment/pocketcoder-server --   pcd superuser create --dir /var/lib/pocketcoder-controller/pc_data   --automation --expires '<UTC timestamp at most 24 hours ahead>'   --request-id '<new UUID>' --json
```

The token is returned once. Store it only in the operator's process or private
credential store. Repeating the same request reconciles the issued key without
returning its plaintext. Replace a lost key through the explicit local admin
replacement path. Never put owner or operator authority in a workspace Secret.

Port-forward the operator Service to localhost. Publish reviewed templates with
`pcd templates import`, create an echo workspace, preserve it, and restore its
checkpoint after moving scheduling to a different node. Readiness requires the
verified restore and a working agent. The local equivalent is
`bun run example:e2e:kubernetes-checkpoint`.

## Optional Pi gateway and public HTTPS

The `pi-gateway` manifests keep provider credentials outside workspace pods. Mint
a separate workspace-scoped gateway bearer with a finite expiry before launch.
The bearer must expire with that workspace; never reuse a standing session
bearer across workspaces. Restricted egress and the selected RuntimeClass must
be tested together on the actual cell.

The public Service overlay requires a real DigitalOcean certificate and narrow
`loadBalancerSourceRanges`. Review it before applying. It serves one controller.
Managed accounts use the shared edge below instead.

## Managed account hosts and public views

The manager gives each account two HTTPS hosts. `ACCOUNT` is the account UUID
without hyphens:

| Host | Serves |
| --- | --- |
| `ACCOUNT.pocketcoder.datazine.app` | The account controller API |
| `*.ACCOUNT.embed.kaset.dev` | That account's webapp, desktop and browser views |

The API and views use different registrable domains. The manager API stays
private. For each account, the manager creates a cert-manager `Certificate` and
an `Ingress` in the account namespace. external-dns publishes both hosts to
DigitalOcean DNS with TXT ownership records, so retries reuse the same records.
[Account purge](../../packages/manager/purge.md) deletes the namespace, which
removes the route, certificate and Secret. external-dns then deletes the records
it owns, and purge waits until DigitalOcean lists none for the account. Give the
purge token `domain:read` in addition to its volume access.

The edge has three parts in [`edge`](edge):

- `traefik.yaml`: one HTTPS entry point behind a DigitalOcean load balancer.
  Access logs stay off because one-time view URLs carry tokens.
- `external-dns.yaml`: DNS records for account Ingress hosts. It is pinned to
  v0.20.0, the last release with the DigitalOcean provider. It selects the whole
  `datazine.app` and `kaset.dev` zones, but publishes only `pocketcoder` Ingress
  hosts and never changes records without its `pocketcoder-ams3-1` ownership record.
- `issuer.yaml`: Let's Encrypt DNS validation for both zones.

Account controllers trust forwarded HTTPS hosts only from the configured pod
range. Their network policy lets only the `pocketcoder-edge` namespace reach the
controller listener, so keep nothing but Traefik in that namespace. Processes on
the node itself can also reach pods and may use an address in the pod range.
They gain nothing a direct client lacks: every request still needs a key or view session.

### Known pilot risks

- **The DNS token reaches every team domain.** DigitalOcean `domain` scopes cover
  all domains in the team, including other production zones. Moving
  `datazine.app` and `kaset.dev`, or delegated sub-zones, to a separate team
  limits what a leaked token can change.
- **Traefik can read every Secret in the cluster.** It needs each account's TLS
  Secret, and Kubernetes cannot grant that per label. A Traefik compromise exposes
  the DNS token, the ACME account key and account Secrets. Keep it pinned and patched.
- **All accounts share the `kaset.dev` site.** A page on one view host can set a
  cookie for `kaset.dev`, and browsers send it to every other account's view
  hosts. PocketCoder's own session cookie is host-only and is not affected, but
  workspace apps are. Before customer use, list `embed.kaset.dev` on the
  [Public Suffix List](https://publicsuffix.org/) or use another isolation
  boundary. Until then, keep the pilot synthetic.

### Bring up the edge

This changes cloud DNS and creates a load balancer (about $12/month). It needs
the same approval and finite write access as the PC-84 cluster. Create one
DigitalOcean token with only `domain` read, create, update and delete scopes and
a 30-day expiry. Certificates renew about every 60 days, so rotate the token
before it expires: store the new token in both Secrets, restart
`deployment/external-dns`, then revoke the old token. Keep it out of shell history, this repository and every account
namespace. Store it in the two system namespaces that use it:

```sh
kubectl create namespace pocketcoder-dns
bun run example:digitalocean:cert-manager > /tmp/cert-manager.yaml
kubectl create -f /tmp/cert-manager.yaml
kubectl -n cert-manager rollout status deployment/cert-manager-webhook
read -rs DIGITALOCEAN_DNS_TOKEN
for namespace in cert-manager pocketcoder-dns; do
  printf %s "$DIGITALOCEAN_DNS_TOKEN" | kubectl -n "$namespace" create secret generic \
    digitalocean-dns --from-file=token=/dev/stdin
done
unset DIGITALOCEAN_DNS_TOKEN
```

Replace `REPLACE_LOAD_BALANCER_NAME` and `REPLACE_ALLOWED_SOURCE_CIDR` in
`edge/traefik.yaml`. The pilot is synthetic, so allow only the operator's test
addresses. Then apply the edge and wait for its address:

The cert-manager webhook can refuse the issuer for a few seconds after its
rollout, so repeat the apply until it succeeds:

```sh
until kubectl apply -k deploy/digitalocean/edge; do sleep 5; done
kubectl -n pocketcoder-edge rollout status deployment/traefik
kubectl -n pocketcoder-edge get service traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
kubectl wait --for=condition=Ready clusterissuer/pocketcoder-dns --timeout=120s
```

Start the manager with the public host settings. `trustedIngress` is the
cluster pod range; DOKS uses `10.244.0.0/16` unless the cluster sets another one.

```sh
export POCKETCODER_MANAGER_PUBLIC_HOSTS='{"apiOrigin":"https://pocketcoder.datazine.app","viewOrigin":"https://embed.kaset.dev","issuer":"pocketcoder-dns","ingressClassName":"pocketcoder","ingressNamespace":"pocketcoder-edge","trustedIngress":["10.244.0.0/16"]}'
```

Create an account with the parent applications that may embed its views:

```sh
curl -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: synthetic-one' \
  -d '{"name":"synthetic one","parents":["https://app.example.org"]}' \
  http://127.0.0.1:8092/v1/accounts
```

The operation succeeds after the controller is ready and its certificate is
issued. DNS validation can take minutes; the manager keeps retrying the same
operation. The account response contains `api_origin` and `view_origin`.
Claim the owner key as before, then call the API at `api_origin`. View sessions
use `top_level` or `embedded` mode, as described in [the API guide](../../docs/api.md#hosted-account-sessions).

Check DNS and HTTPS from the operator machine:

```sh
dig +short "$ACCOUNT.pocketcoder.datazine.app"
dig +short "check.$ACCOUNT.embed.kaset.dev"
curl -fsS "https://$ACCOUNT.pocketcoder.datazine.app/readyz"
```

Each account uses one Let's Encrypt certificate. Let's Encrypt allows 50 new
certificates per registered domain each week; plan customer growth with that limit.

### Remove the edge

Remove every account's hosts before the edge. Otherwise its DNS records keep
pointing at a released load balancer address that someone else could receive.
Purge each account through the manager and wait until its operation succeeds.
Without a purge configuration, remove each synthetic account by hand:

1. Cancel its workspaces through the account API and wait until they are
   `canceled`. Workspace pods keep a finalizer that only the controller removes.
2. `kubectl delete namespace pc-account-ACCOUNT`, then
   `kubectl delete clusterrole,clusterrolebinding pc-account-ACCOUNT-nodes`.
3. Wait until `doctl compute domain records list kaset.dev` and
   `doctl compute domain records list datazine.app` show no record containing
   `ACCOUNT`, including the `a-` ownership TXT records.

After manual removal the manager database still lists the removed accounts.
Then remove the edge and the DNS token:

```sh
kubectl delete -k deploy/digitalocean/edge
kubectl -n cert-manager delete secret digitalocean-dns pocketcoder-acme-account
kubectl delete -f /tmp/cert-manager.yaml
doctl compute domain records list kaset.dev
doctl compute domain records list datazine.app
```

Revoke the DNS token in the DigitalOcean control panel. Confirm that no
`pocketcoder-ams3-1` ownership records remain and the load balancer is gone.

The local equivalent runs the same edge manifests in kind with a local CA and
PowerDNS instead of Let's Encrypt and DigitalOcean DNS:

```sh
bun run example:e2e:managed-public-views
```

## Backup and cleanup

Use `pcd backup create` to freeze and capture the controller database, keys and
referenced archives together. Keep the deletion journal outside the backup
rollback boundary. Encrypt off-node archives with a separately held key and
include retained versions in account purge. Test fresh-volume restore before
using customer data.

Delete owned workspace data through the API and wait for successful operations
before removing the controller. Deleting a namespace or PVC is not proof that
retained backups are gone. Remove the deployment and retained block volume only
when its current deletion and backup inventory proves cleanup.
