# PC-103 production layout and disposable recovery proof

The full monthly operating budget is **$200 maximum**. It includes tax,
variable charges, recovery tests and owned cleanup. No extra trial budget or
automatic cost increase is authorized. The disposable trial was started on
13 October 2026 with the finite `pocketcoder-writer` context. Its recorded expiry
is 13 January 2027. Customer admission stays closed. Hosted runtime and recovery
proof remain incomplete.

The initial `main.tf` apply created ten new infrastructure resources in the existing Pockercoder project,
`126c5d77-926b-475b-8111-e30f3992a338`, in Pufflig AB. The project is not
disposable. The resources are a dedicated VPC, standard DOKS cluster, workspace pool,
operator host and firewall, two operator volumes and their attachments, and
the project assignment. No Kito resource is imported or changed. `storage.tf` adds the approved private
RustFS service and its separate 10-GiB PVC to the same cell. Operator startup data
now records the release, services and credential renewal.

## Layout

| Role | Candidate resource | Placement and storage |
| --- | --- | --- |
| Control plane | Standard DOKS, `pocketcoder-pc103-recovery` | ams3; Kubernetes `1.34.12-do.0`; paid HA disabled |
| Account controllers and edge | Two `s-2vcpu-4gb` system workers | One controller replica/account; two edge replicas spread across workers |
| Coding workspaces | One fixed `s-4vcpu-8gb` worker | Workspace taint; gVisor only; Cilium enforced |
| Manager and backup timers | `pocketcoder-pc103-operator`, `s-2vcpu-4gb` | Loopback manager listener; SSH tunnel for operators |
| Manager data | `pocketcoder-pc103-manager`, 10 GiB | Private ext4 volume; one kernel writer lock |
| Independent manager authority | `pocketcoder-pc103-journal`, 1 GiB | Separate volume and rollback boundary; never archived |
| Two synthetic accounts | Two CSI volumes, 10 GiB each | Manager-created; retain exact volume IDs |
| Monitoring | One 1 GiB volume | PC-53 configuration and named operator receiver |
| Off-node evidence | Approved RustFS on a separate 10-GiB PVC | Private NodePort; first boot, storage recovery and headroom must be proved |

The proposed VPC is `10.110.128.0/20`. On 13 October 2026, DigitalOcean refused
the earlier `10.110.64.0/20`: it overlaps the existing Kubernetes service range
`10.110.64.0/19`, which the VPC list does not expose. Check both VPC ranges and
each cluster's `cluster_subnet` and `service_subnet` before choosing a network.
The only existing cluster is `kito2-somefrogs-staging`; it is outside this proof.
The droplet limit is 25. Recheck inventory and quota
before applying, including a replacement node and temporary recovery host.

Terraform supplies the generated operator startup configuration. It installs a
checksum-pinned operator release, mounts the retained volumes, renews finite
access, starts the manager and backup schedules, and records authenticated
readiness. See [repeatable operator deployment](DEPLOYMENT.md). The reserved
gVisor change and the public edge remain separate rollout steps.
Each system worker has 2 vCPUs and 4 GiB. Before opening traffic, prove that
one worker can run both synthetic account controllers, the edge and required
system services with headroom. If that proof fails, reduce admitted account
capacity or revise the plan; do not silently resize workers. PC-54 owns measured
admission limits. This candidate is not a tested customer capacity.

The workspace pool has no autoscaling. New work must queue or be refused when
the single worker is full. A failed workspace worker pauses coding until its
replacement is ready; the two system workers retain account controller and edge
placement. The recovery trial must include that delay in RTO. Keep gVisor,
enforced egress, separate operator data and independent journals. No second
permanent workspace worker fits this budget.

The standard managed control plane saves $40/month. It does not provide the
paid HA control plane's availability guarantee. Recovery needs a working
Kubernetes API; if that API is unavailable, keep admission closed until it
returns. Include that wait in recovery time. Two system workers retain the
worker-failure placement proof; gVisor and network policy stay enforced.

## Verified prices and budget

The read-only size API on 12 October 2026 returned $48/month and $0.07143/hour
for `s-4vcpu-8gb`, and $24/month and $0.03571/hour for `s-2vcpu-4gb`.
Both are available in ams3. Kubernetes `1.34.12-do.0` remains available;
use the same version as the separately tested pilot.

| Resource | Monthly USD budget |
| --- | ---: |
| Two system workers | 48.00 |
| One workspace worker | 48.00 |
| Operator host | 24.00 |
| Standard managed control plane | 0.00 |
| One regional load balancer, one size unit | 12.00 |
| Unused object-storage/transfer reserve | 5.00 |
| 42 GiB of manager/journal/account/monitoring/RustFS volumes | 4.20 |
| **Baseline** | **141.20** |
| Two extra 10 GiB restore volumes, if retained | +2.00 |
| **Listed resources with restore volumes** | **143.20** |
| Conservative 25% tax reserve on listed resources | 35.80 |
| Remaining room for variable charges and recovery | 21.00 |
| **Total monthly boundary** | **200.00** |

This replaces the earlier proposals. On 12 October the operator made $200/month
the full boundary, not a base price with extras. Tax reserve is a budgeting
assumption, not a statement about the actual invoice tax rate. Use actual
invoiced tax and service usage in the month's forecast. DigitalOcean does not
enforce this total automatically.

These are list-price estimates, not a measured bill. Tax, network overage,
Spaces overage, snapshots, replacement hosts and detached volumes all count
toward $200. The lean PC-84 pilot and this layout must not run in parallel as
two permanent cells. Account for any pilot overlap in the same month.

Before creating or replacing a resource, record month-to-date charges, the
projected cost of all retained resources, tax and a cleanup allowance. Do not
start work whose forecast exceeds $200. Disable paid snapshots and workspace
autoscaling; stop new work before storage or transfer would exceed the remaining
allowance. Alert-only billing notices do not establish budget enforcement.

The recovery trial uses the remaining monthly allowance; it has no extra
budget. Run it only when the forecast covers temporary resources and cleanup.
A replacement operator host is $0.03571/hour; a replacement workspace worker
is $0.07143/hour. Prefer replacement after source fencing rather than prolonged
overlap. If remaining funds are insufficient, postpone the trial or release
idle owned resources. Never request a budget increase or weaken fencing to fit.
Verify removal; detached volumes still accrue charges.

Sources: [DOKS billing](https://docs.digitalocean.com/products/kubernetes/details/pricing/),
[volume billing](https://docs.digitalocean.com/products/volumes/details/pricing/),
[load balancer billing](https://docs.digitalocean.com/products/networking/load-balancers/details/pricing/),
[Spaces billing](https://docs.digitalocean.com/products/spaces/details/pricing/).
The actual Spaces bucket proof failed on 13 October 2026: two conditional PUTs
to the same key both succeeded and the second value became current. Versioning
retained both versions but did not protect the immutable writer claim. Spaces
cannot hold the current recovery journals safely. The operator approved RustFS
on 13 October, using the unused reserve for its volume and tax. Keep recovery
closed until the live backend passes the conditional-write and recovery proofs. Evidence and
the repeatable command are in PC-103 report RP-250.

## Saved plan and access

The 12 October plan has **10 additions, 0 changes, 0 deletions**. It is stored
at `~/.pocketcoder-operator/pc103/recovery.tfplan`, mode 0600, in a mode-0700
operator folder. Its proposed SSH key is the existing public key `do-aure`,
ID `50859617`. The operator confirmed this key and SSH source
`83.249.36.119/32` in review request `a2f9a43a` on 12 October. Recheck that the
source address still matches before applying. Never copy private keys or tokens
into Terraform variables.

Refresh the plan if its source files, region inventory, source address or price
change. Keep state and finite kubeconfigs in the private operator folder.
The saved `pc75-operator` context is read-only. It does not authorize apply.
Finite access must cover only the named trial resources and their cleanup:
cluster/VPC/pool creation and deletion, operator Droplet/firewall/volume
creation and attachment, provider power-off evidence, and project assignment.
PC-111's pilot scopes do not cover every extra PC-103 resource.
The $200 boundary is already the saved cost decision. The replacement finite
context now permits the named resource reads and the trial apply. The approved SSH public key remains available for diagnosis. Its local private
key is not required to install services; Terraform startup configuration performs
that installation.

After obtaining the required finite resource access, use the private-folder plan flow from
[PC-84](../pilot/README.md). Never apply from repository state.
Validate the proposal without cloud changes:

```sh
terraform -chdir=deploy/digitalocean/production init -backend=false
terraform -chdir=deploy/digitalocean/production fmt -check
terraform -chdir=deploy/digitalocean/production validate
terraform -chdir=deploy/digitalocean/production show -no-color \
  ~/.pocketcoder-operator/pc103/recovery.tfplan
```

Generate the private startup configuration and apply its reviewed Terraform
plan through [the deployment command path](DEPLOYMENT.md). The manager stays on
loopback, and the manager and journal volumes retain stable mount paths. Keep
the private input and separate archive key recoverable in operator storage.
Neither belongs in a workspace or database archive. Changing startup data
replaces the operator host; verify fencing and retain both volumes first.

## Decision and remaining proof

Work within the saved $200/month boundary. Do not ask to raise it or add a
separate trial allowance. SSH source/key were confirmed. The trial apply used
the confirmed finite context and the saved forecast inside the boundary.
The operator approved the exact RP-250 gVisor installer and diff and the RustFS
backend in request `a766926d`. The named worker installation completed with both
checksums verified and containerd active. Customer enablement remains PC-69's separate decision.

PC-103 remains incomplete until the [failure runbook](../../../docs/hosted-node-recovery.md)
has actual provider evidence: powered-off source node, relocated volume,
single writer, working workspace, manager restore with current purge replay,
and measured recovery times. No hosted RPO or RTO has been measured yet.
The current manager transfer binds the original filesystem device/inode.
An unreachable or unproved source remains fenced. A verified host and exact
provider volume permit Linux device renumbering while native locks stay strict. Never
edit writer markers to force relocation; the provider-backed transfer path
must still be implemented and proved during the owned recovery work.
