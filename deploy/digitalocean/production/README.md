# PC-103 production layout and disposable recovery proof

This is a candidate layout for operator review. It has not been applied.
Customer admission stays closed. The PC-84/85 pilot still needs its finite
operator access and hosted runtime proof.

`main.tf` prepares ten new resources in the existing Pockercoder project,
`126c5d77-926b-475b-8111-e30f3992a338`, in Pufflig AB. The project is not
disposable. The resources are a dedicated VPC, HA DOKS cluster, workspace pool,
operator host and firewall, two operator volumes and their attachments, and
the project assignment. No existing resource is imported or changed.

## Layout

| Role | Candidate resource | Placement and storage |
| --- | --- | --- |
| Control plane | HA DOKS, `pocketcoder-pc103-recovery` | ams3; Kubernetes `1.34.12-do.0` |
| Account controllers and edge | Two `s-2vcpu-4gb` system workers | One controller replica/account; two edge replicas spread across workers |
| Coding workspaces | One fixed `s-4vcpu-8gb` worker | Workspace taint; gVisor only; Cilium enforced |
| Manager and backup timers | `pocketcoder-pc103-operator`, `s-2vcpu-4gb` | Loopback manager listener; SSH tunnel for operators |
| Manager data | `pocketcoder-pc103-manager`, 10 GiB | Private ext4 volume; one kernel writer lock |
| Independent manager authority | `pocketcoder-pc103-journal`, 1 GiB | Separate volume and rollback boundary; never archived |
| Two synthetic accounts | Two CSI volumes, 10 GiB each | Manager-created; retain exact volume IDs |
| Monitoring | One 1 GiB volume | PC-53 configuration and named operator receiver |
| Off-node evidence | Private versioned Spaces bucket in ams3 | Encrypted archives and current journals; no CDN |

The proposed VPC is `10.110.64.0/20`. Read-only inventory on 12 October 2026
showed no overlap. The only existing cluster is `kito2-somefrogs-staging`;
it is outside this proof. The droplet limit is 25. Recheck inventory and quota
before applying, including a replacement node and temporary recovery host.

Terraform does not bootstrap services, install gVisor, create the public edge,
or enable backups. Those steps follow approval and the PC-84 runtime proof.
Each system worker has 2 vCPUs and 4 GiB. Before opening traffic, prove that
one worker can run both synthetic account controllers, the edge and required
system services with headroom. If that proof fails, reduce admitted account
capacity or revise the plan; do not silently resize workers. PC-54 owns measured
admission limits. This candidate is not a tested customer capacity.

The workspace pool has no autoscaling. New work must queue or be refused when
the single worker is full. A failed workspace worker pauses coding until its
replacement is ready; the two system workers retain account controller and edge
placement. The recovery trial must include that delay in RTO. Keep gVisor,
enforced egress, HA control plane, separate operator data and independent
journals. Adding a second permanent workspace worker needs a new cost decision.

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
| HA control plane | 40.00 |
| One regional load balancer, one size unit | 12.00 |
| Spaces base subscription | 5.00 |
| 32 GiB of manager/journal/account/monitoring volumes | 3.20 |
| **Baseline** | **180.20** |
| Two extra 10 GiB restore volumes, if retained | +2.00 |
| **Planned steady ceiling** | **182.20** |

This replaces the rejected $228.20 baseline / $278.20 ceiling. The operator
asked on 12 October to stay closer to $200/month. Smaller system workers save
$48/month; fixing the workspace pool at one node removes another $48/month
from the former ceiling. The listed steady resources leave $17.80/month below
$200 for variable costs. This is not a provider-enforced total bill cap.

These are current list-price estimates, not a measured bill. Tax, excess
network traffic, Spaces storage above the shared 250 GiB allowance, snapshots,
and temporary replacement hosts are extra. A replacement operator host adds
up to $24/month while it exists, or $0.86 for 24 hours. Budget $15 for a
24-hour disposable proof with one temporary replacement host. The listed
resources, retained restore volumes and that host cost about $7.36 for the day
using the verified hourly worker prices and prorating the other listed charges
over 28 days. Reserve the full $5 Spaces monthly price conservatively; replacing
its daily share with that reserve brings the estimate to about $12.19.
Spaces documents hourly proration when all buckets are deleted; cleanup must
verify that condition before relying on the lower charge.
Stay within the $15 trial budget and
stop if the remaining budget cannot cover owned cleanup. Detached volumes still
accrue charges.

Sources: [DOKS billing](https://docs.digitalocean.com/products/kubernetes/details/pricing/),
[volume billing](https://docs.digitalocean.com/products/volumes/details/pricing/),
[load balancer billing](https://docs.digitalocean.com/products/networking/load-balancers/details/pricing/),
[Spaces billing](https://docs.digitalocean.com/products/spaces/details/pricing/).
Spaces conditional writes and consistent writer/version listings still need
the actual bucket proof; [S3 compatibility](https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/)
alone does not establish those properties.

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
Request those additions after the cost/layout decision.

After approval, use the private-folder plan flow from
[PC-84](../pilot/README.md). Never apply from repository state.
Validate the proposal without cloud changes:

```sh
terraform -chdir=deploy/digitalocean/production init -backend=false
terraform -chdir=deploy/digitalocean/production fmt -check
terraform -chdir=deploy/digitalocean/production validate
terraform -chdir=deploy/digitalocean/production show -no-color \
  ~/.pocketcoder-operator/pc103/recovery.tfplan
```

Install pinned candidate artifacts on the separate operator host, with no
public manager port. Mount operator volumes at stable paths. Keep private
configuration and the separate archive key recoverable from the operator's
secure storage. Neither belongs in a workspace or database archive.

## Decision and remaining proof

The operator must approve the revised layout, $182.20/month steady ceiling
plus listed variable costs, and $15/24-hour named synthetic failure trial before
apply. The previous cost decision was denied; SSH access was confirmed.
Customer enablement
remains PC-69's separate decision. The saved lean pilot approval does not cover
this larger layout.

PC-103 remains incomplete until the [failure runbook](../../../docs/hosted-node-recovery.md)
has actual provider evidence: powered-off source node, relocated volume,
single writer, working workspace, manager restore with current purge replay,
and measured recovery times. No hosted RPO or RTO has been measured yet.
The current manager transfer binds the original filesystem device/inode.
An unreachable or differently numbered source device remains fenced. Never
edit writer markers to force relocation; the provider-backed transfer path
must still be implemented and proved during the owned recovery work.
