# PC-84 synthetic pilot plan

This is the approval-stage plan for PC-84. No cloud resource has been created.
The infrastructure files can seed the empty `pufflyai/pocketcoder-ops` repository.
The hosted demo is still required before PC-84 can be completed.

## Proposed resources

Use the existing **Pockercoder** project,
`126c5d77-926b-475b-8111-e30f3992a338`, in Pufflig AB. Create the separately named
`pocketcoder-pc84-synthetic` cluster in `ams3` for cell `ams3-1`.

Terraform creates four resources: a dedicated `10.110.48.0/20` VPC, the cluster
with one system node, a workspace node pool, and the cluster's project assignment.
It does not import or modify the existing staging cluster, project or VPCs.
The existing project is not disposable.

Pin Kubernetes to `1.34.12-do.0` and the provider to `2.105.0`. Both are currently
available. Explicitly disable the paid HA control plane and automatic upgrades
for this short synthetic trial. The system pool has one `s-4vcpu-8gb` node.
The workspace pool uses the same size, scales from zero to one, and carries a
workspace-only taint. RuntimeClass scheduling must select and tolerate that pool.
No load balancer, DNS record, public manager listener or customer traffic is
part of this plan. Public HTTPS belongs to PC-85.

After the runtime and network checks, Kubernetes creates one private 1 GiB
manager volume and two private 10 GiB account volumes. Manager and account
controllers stay on the system node. Workspaces run on the gVisor worker only.
All fixture objects must carry the trial identity; record each PVC's cloud
volume ID before the demo. Keep Terraform state and finite kubeconfig files in
an operator-owned folder outside every workspace, with directory mode 0700 and
file mode 0600. No credential is passed as a Terraform variable or output.

## Cost and read-only inventory

Checked on 10 October 2026 with `doctl --context pc75-operator`: the account is
active; its droplet limit is 25, with four existing droplets. The selected project
currently has no assigned resources. The only existing DOKS cluster is
`kito2-somefrogs-staging`; it is outside this trial. The proposed VPC range does
not overlap the listed VPCs. Recheck availability before applying.

| Resource | Monthly USD estimate |
| --- | ---: |
| One system node | 48.00 |
| One manager volume, 1 GiB | 0.10 |
| Two account volumes, 20 GiB total | 2.00 |
| Workspace node at zero | 0.00 |
| **Idle trial total** | **50.10** |
| Workspace node, when running all month | +48.00 |
| **Maximum planned steady total** | **98.10** |

The node price is from the current DigitalOcean size API: `$0.07143/hour`, capped
at `$48/month`. Block volumes cost `$0.10/GiB/month` and accrue charges while
they exist, including after detachment. A 24-hour trial with both nodes and all
three volumes is about `$3.50` before tax and any bandwidth overage. This is a
cost estimate, not a bill or a production budget.

Sources: [node billing](https://docs.digitalocean.com/products/kubernetes/details/pricing/),
[volume billing](https://docs.digitalocean.com/products/volumes/details/pricing/),
[scale to zero](https://docs.digitalocean.com/products/kubernetes/how-to/autoscale/).

## Runtime decision and prerequisites

DOKS manages the worker filesystem and container daemon configuration. Its
reconciler can overwrite local changes. The standard gVisor containerd setup
requires installing `runsc`, its shim and sidecar files, configuring a runtime
handler, and restarting containerd. A RuntimeClass object alone is not proof
that gVisor works.

This plan therefore proposes a **disposable compatibility trial** on the new
workspace node only. Capture its actual containerd version/config first, then
review the exact installer against that configuration. Pin the complete gVisor
release archive and verify its published checksum. Do not modify Cilium or
CoreDNS, and do not replace the worker's existing containerd configuration.
Customer operation remains disabled. A successful echo is only trial evidence;
it is not proof that this node customization survives DOKS maintenance.

Stop if the reconciler removes the runtime or the trial cannot enforce egress.
There is no runc fallback. Moving to a different cluster provider or self-managed
nodes is a separate operator decision. Do not silently change the agreed plan.

Before the hosted demo, implement and test the manager's Cilium readiness check:
the current manager requires Calico, whereas DOKS supplies Cilium. Also render
the private manager deployment and gVisor RuntimeClass scheduling from the
observed node setup. These are remaining PC-84 work; they are not claimed done.

Sources: [DOKS managed workers](https://docs.digitalocean.com/products/kubernetes/details/managed/),
[gVisor containerd setup](https://gvisor.dev/docs/user_guide/containerd/quick_start/),
[complete gVisor installation](https://gvisor.dev/docs/user_guide/install/).

## Review and apply commands

Copy the reviewed configuration from `deploy/digitalocean/pilot`, or the same
files in the ops checkout, into a private host folder outside every workspace.
Run Terraform only there: applied state contains finite Kubernetes credentials.
Use a short-lived DigitalOcean credential in the operator process environment.
The current `pc75-operator` context has read-only authorization; it is not apply
authority. Confirm its expiry before reuse. Do not print or save its token.

```sh
umask 077
PC84_SOURCE_DIR="$PWD/deploy/digitalocean/pilot"
PC84_OPS_DIR="/private/operator/pocketcoder-pc84"
install -d -m 0700 "$PC84_OPS_DIR"
cp "$PC84_SOURCE_DIR/main.tf" "$PC84_SOURCE_DIR/.terraform.lock.hcl" "$PC84_OPS_DIR/"
chmod 0600 "$PC84_OPS_DIR/main.tf" "$PC84_OPS_DIR/.terraform.lock.hcl"
cd "$PC84_OPS_DIR"
terraform init -input=false
terraform fmt -check
terraform validate
terraform plan -input=false -out=pc84.tfplan
terraform show -no-color pc84.tfplan
```

After approval of the resource scope and cost, obtain finite write access for
the trial's VPC, cluster/node pools, project assignment, and Kubernetes-owned
volumes. Review the fresh saved plan; it must show four additions and no changes
or removals. Apply only that reviewed plan:

```sh
terraform apply pc84.tfplan
terraform output -raw cluster_id
```

Use that exact returned cluster ID to request a 30-minute kubeconfig in a private
operator folder. All `kubectl` commands must select that kubeconfig explicitly.
Do not change the default context. Cluster-admin access is needed for this new
trial's runtime installation, manager RBAC and account isolation probes.
Set `PC84_OPS_DIR` to a real private operator path on the host. Keep that folder
unmounted in manager, controller and workspace containers. All later apply and
destroy commands also run in that folder.
The present Terraform approval covers resource creation and owned cleanup. It
does not approve an unwritten privileged installer. Capture the new worker's
configuration read-only and present the pinned installer and configuration diff
for review before requesting permission to change that worker.

## Artifacts and hosted acceptance

The `synthetic pilot images` workflow runs on integration-branch pushes. It first
runs repository CI, then
publishes manager, server and workspace images from one commit. It records the
three digest references and source SHA. It only writes `pilot-<full SHA>` tags;
it does not publish `latest`, stable tags or a release. Use those digest
references in deployed manifests. Test registry pull access before admitting
accounts; any registry credential remains outside workspace pods.
The manual trigger becomes available once the workflow exists on the default
branch. Until then, use the integration-branch push run after this draft merges.

The hosted demo must create two synthetic accounts through the private manager
API, retry interrupted creation, claim finite owner keys once, publish the echo
template, and run a workspace with an echo response. Reuse
`examples/e2e/managed-accounts.ts` and `managed-account-probes.ts`. Add an actual
gVisor check inside the workspace and cross-account/own-operator network denial.
Restart the first account controller normally; verify the same PVC, owner key,
template and transcript afterward. Do not simulate a failed node or force-detach
an unfenced volume. Verify that missing gVisor prevents workspace admission.

Clean up workspaces through their owning APIs and wait for confirmed removal.
Remove only recorded trial account namespaces, their cluster RBAC bindings,
and the private trial manager. Wait for the recorded PVC/cloud volume IDs to
disappear before destroying the cluster and VPC:

```sh
terraform plan -destroy -out=pc84-destroy.tfplan
terraform show -no-color pc84-destroy.tfplan
terraform apply pc84-destroy.tfplan
```

`destroy_all_associated_resources` is false. Terraform must not substitute for
the account content cleanup proof. Check for remaining owned volumes/snapshots
and preserve logs without credentials. Never delete the existing project.
