# Repeatable operator deployment

Terraform creates the operator host with its startup configuration. No interactive
SSH installation is required. The same path installs a fresh host or rebuilds a
fenced host while retaining the manager and independent journal volumes.

The `operator-release` mode of the existing `images` workflow builds the manager, backup runners and access
runner from one clean commit. It tests the extracted bundle without the source
checkout and publishes a checksum-pinned synthetic candidate. An existing
candidate must have the same commit and checksum; the workflow refuses an
overwrite. The runtime and controller images are also pinned by digest.

## Deploy

1. Run `images.yml` with `operator-release=true` for the reviewed implementation branch. Read
   `operator.json` from its candidate release and retain the commit and checksum.
2. Keep the deployment input, cloud credential, compatible S3 configuration,
   retained 32-byte archive key, Terraform state and generated startup file in a
   mode-0700 operator folder outside every repository and workspace. Private
   files use mode 0600. The cloud credential contains `token`, its confirmed
   `expiresAt`, and the exact trial `clusterId`. Never put these files in Git.
3. Generate startup configuration:

   ```sh
   bun run operator:cloud-init /private/operator/deployment.json /private/operator/cloud-init.yaml
   ```

4. Set `operator_cloud_init_file` to the generated private path in the private
   Terraform input. Copy the reviewed Terraform source to the existing private
   state folder, then use the saved plan/apply workflow. Inspect resource names
   and volume retention before applying. Startup data changes replace the
   operator host; no workspace worker or Kito resource belongs in that change.
   Set `operator_kubeconfig_file` to the finite trial kubeconfig,
   `backup_storage_config_file` to the same private RustFS configuration, and
   `backup_storage_node` to the recorded system worker. `storage.tf` manages its
   namespace, Secret, 10-GiB PVC, Deployment, private service and ingress policy.
5. Read `pc103-operator-ready` in `kube-system` through the finite kubeconfig.
   Require the expected Droplet ID, full source commit and archive checksum.
   Require a readiness timestamp after the recorded boot/reboot action. For a
   reboot, also require a changed kernel boot ID; an earlier ConfigMap is stale.
    A missing or mismatched record is an incomplete deployment.

The private `deployment.json` contains these fields. Paths are examples, not
credential values:

```json
{
  "artifact": {
    "url": "https://github.com/pufflyai/pocketcoder/releases/download/operator-candidate-<full-commit>/operator.tar.gz",
    "sha256": "<operator.json sha256>",
    "commit": "<full-commit>"
  },
  "runtimeImage": "ghcr.io/pufflyai/pocketcoder/manager@sha256:<reviewed-digest>",
  "controllerImage": "ghcr.io/pufflyai/pocketcoder/server@sha256:<reviewed-digest>",
  "runtimeClass": "pc103-gvisor",
  "storageConfigFile": "/private/operator/storage.json",
  "encryptionKeyFile": "/private/operator/archive-key",
  "cloudCredentialFile": "/private/operator/cloud-credential.json"
}
```

The generated startup payload and Terraform state contain private configuration.
Keep both in the private operator folder. Only the trusted operator host receives
the payload; customer workspace nodes do not receive it. The approved SSH public
key stays available for diagnosis and recovery access, rather than installation.

## Startup and reboot

The enabled boot service installs and verifies the exact release on every boot.
It mounts the retained volumes, refreshes a thirty-minute Kubernetes credential,
and probes S3 using two real conditional writes. The second must return HTTP 412,
one unchanged writer version must remain, and the owned probe is removed.

The service then issues separate schedule and metrics keys with at most
twenty-hour expiry, starts the manager, waits up to thirty seconds for an
authenticated request, and completes initial account and manager captures in
order. Only then does it start backup and access-renewal timers and publish the
readiness record. Kubernetes access refreshes every ten minutes. Operator keys
rotate every twelve hours, under the same maintenance lock as manager capture.
The cloud credential retains its confirmed expiry; renewal never extends it.

RustFS is reached through the selected system worker's private address on port
30900. Local NodePort routing retains the operator source address. Ingress permits
only the operator's private `/32` and account controller pods. Terraform creates
this restriction before starting or exposing storage. Credentials come from the
private input and are held by the storage service and trusted controllers.

The selected endpoint node is a recorded trial placement, not an availability
claim. Fencing, volume movement, endpoint changes and remaining-node headroom
must be proved before accepting storage-node recovery. Actual controller access
through Cilium and NodePort also needs a live check.

Manager data, independent authority and backup receipts stay on their separate
retained mounts. The archive key stays outside both volumes. The manager listens
only on loopback. A failed storage contract or uncertain writer identity stops
startup. Deployment does not reset a lock, writer claim, deletion journal or
recovery marker to make a restored host start.

## Recovery proof

Use the same recorded release and startup inputs for a fenced replacement.
Retain the original volume IDs and independent authority. Complete the existing
restore and journal replay protocol before expecting a relocated manager to
start. A changed source device/inode still refuses unproved transfer.

First-boot and reboot readiness, delivered alerts, worker runtime validation,
remaining-node capacity and real failure/recovery measurements are still required
for hosted acceptance. A passing local bundle test does not prove them. Keep
customer admission closed and retain the existing $200 total boundary and trial
cleanup deadline.
