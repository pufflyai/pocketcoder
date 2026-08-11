# Run a remote Pi coding session

This flow adds one Pi workspace and one private model gateway to the
DigitalOcean example. It is for a bounded internal session. It is not a shared
or paid model gateway.

The provider key exists only in the gateway Pod. The workspace receives one
random bearer through a projected Secret key. The gateway accepts that bearer
for one model, text-only requests, bounded request bytes, at most 50 requests,
at most 4096 output tokens per request, and no longer than one hour.

## Build the two images

Build from the repository root. Push both images to the registry used by DOKS.
Use a release tag for transport, then record the immutable registry digests.

```bash
docker buildx build \
  --platform linux/amd64 \
  --file examples/harnesses/pi/Dockerfile \
  --tag '<registry>/pocketcoder-pi:<release>' \
  --push .

docker buildx build \
  --platform linux/amd64 \
  --file examples/harnesses/pi/gateway.Dockerfile \
  --tag '<registry>/pocketcoder-pi-gateway:<release>' \
  --push .
```

Resolve each pushed image to `repository@sha256:<64 hex>`. Put the Pi digest in
`digitalocean/server/templates/pi-harness.json` and the gateway digest in
`digitalocean/pi-gateway/kustomization.yaml` inside the ignored working copy.
Set the same OpenAI model in the Pi template and `gateway.yaml`.

Render all four phases and run the preflight command from the main
[DigitalOcean guide](./README.md). Preflight rejects mutable images, unmatched
models, a literal workspace bearer, and a privileged or public gateway.

## Create one session Secret

The workspace and gateway must use the same random bearer. Only the gateway
gets the provider-key field. The workspace template projects only the bearer
field.

Run this on the trusted operator machine. Hidden input keeps the provider key
out of shell history. The temporary directory is mode 0700 and is removed after
the Kubernetes Secret is created.

```bash
session_directory="$(mktemp -d)"
chmod 0700 "$session_directory"
trap 'rm -r -- "$session_directory"' EXIT

read -r -s -p 'OpenAI API key: ' provider_key
printf '\n'
printf '%s' "$provider_key" >"$session_directory/openai-api-key"
unset provider_key

session_bearer="$(openssl rand -base64 32 | tr -d '\n')"
printf '%s' "$session_bearer" >"$session_directory/bearer"
unset session_bearer

session_expiry="$(bun -e 'console.log(new Date(Date.now() + 3_600_000).toISOString())')"
printf '%s' "$session_expiry" >"$session_directory/expires-at"
unset session_expiry

kubectl -n pocketcoder create secret generic pocketcoder-pi-gateway-session \
  --from-file=openai-api-key="$session_directory/openai-api-key" \
  --from-file=bearer="$session_directory/bearer" \
  --from-file=expires-at="$session_directory/expires-at"

rm -r -- "$session_directory"
trap - EXIT
unset session_directory
```

Do not reuse this Secret for another workspace. If it already exists, finish
or delete the old session before creating a new one.

## Start the gateway

```bash
kubectl apply -k .pocketcoder/digitalocean/pi-gateway
kubectl -n pocketcoder rollout status \
  deployment/pocketcoder-pi-gateway --timeout=5m
```

The Service is `ClusterIP`. Its NetworkPolicy accepts port 8080 only from Pods
with PocketCoder workspace labels. The gateway has no service-account token and
runs as uid/gid 10001 with a read-only root filesystem.

## Launch Pi

The main guide exports `POCKETCODER_URL` and a one-hour `POCKETCODER_KEY`. The
principal must allow the `pi-harness` template and the `terminal:attach` scope.

```bash
workspace_id="$(
  bun run pcd -- workspaces create \
    --template pi-harness \
    --external-id digitalocean-pi-session \
    --wait --json | \
  bun -e 'const value = await new Response(Bun.stdin.stream()).json(); console.log(value.id)'
)"
```

Open the workspace shell:

```bash
bun run pcd -- workspaces terminal --id "$workspace_id"
```

Type `exit` or press Ctrl-D to close the remote shell. The workspace keeps
running until it is canceled or reaches its timeout.

To use the local Pi interface while the coding agent and tools stay in the
workspace:

```bash
POCKETCODER_WORKSPACE_ID="$workspace_id" \
bunx @pstdio/pocketcoder-remote
```

You can also send a turn through the direct workspace chat:

```bash
bun run pcd -- workspaces chat --id "$workspace_id"
```

## Verify the credential boundary

Resolve the workspace Pod and confirm that Kubernetes projected only the
bearer. The provider key must not exist in the workspace filesystem.

```bash
workspace_pod="$(
  kubectl -n pocketcoder get pod \
    -l "pocketcoder.dev/workspace-id=$workspace_id" \
    -o jsonpath='{.items[0].metadata.name}'
)"

kubectl -n pocketcoder exec "$workspace_pod" -- sh -c '
  test -f /run/pocketcoder/secrets/pocketcoder-pi-gateway-session%2Fbearer
  test ! -e /run/pocketcoder/secrets/pocketcoder-pi-gateway-session%2Fopenai-api-key
'
unset workspace_pod
```

The bearer is intentionally readable inside this workspace. It has no value
outside this private gateway and cannot bypass the gateway limits.

## End the session

Cancel the workspace first. Then delete the gateway and its Secret. The hard
expiry is a backstop, not a substitute for cleanup.

```bash
bun run pcd -- workspaces cancel --id "$workspace_id"
kubectl delete -k .pocketcoder/digitalocean/pi-gateway
kubectl -n pocketcoder delete secret pocketcoder-pi-gateway-session
unset workspace_id
```

Deleting the Secret does not remove a value already loaded into a running
gateway process. Deleting the gateway Deployment in the same cleanup step is
therefore required.
