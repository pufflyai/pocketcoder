# Upgrading from coder-lite

This is the complete public rename delta from coder-lite to PocketCoder. The
table is frozen through PocketCoder 1.0: no additional coder-lite names will be
renamed or removed before that release.

| coder-lite | PocketCoder |
|------------|-------------|
| `coder-lite` | `pocketcoder` |
| `CODER_LITE_*` environment variables | `POCKETCODER_*` |
| `coder-lite.dev/v1alpha1` | `pocketcoder.dev/v1alpha1` |
| `X-Coder-Lite-Signature` | `X-Pocketcoder-Signature` |
| `/run/coder-lite/input` | `/run/pocketcoder/input` |
| `/opt/coder-lite/ctl.js` | `/opt/pocketcoder/pcd.js` |
| `coder-lite-agent` binary | `pocketcoder-agent` |

Apply the rename in one pass across deployment scripts, Compose/Kubernetes
manifests, environment and secret names, template manifests, workspace images,
event signature verification, control-plane invocations, and backend adapters.
Do not mix old and new identifiers within one deployment.

After the replacement:

1. Pin the server image and every workspace image by digest.
2. Run database migrations with `pcd db migrate`.
3. Validate every reviewed template.
4. Run `pcd doctor --template <production-template>`.
5. Confirm a signed event using `X-Pocketcoder-Signature`.

`doctor: ok` now means a non-root workspace passed its declared in-memory path
write checks and completed a correlated request/response turn through the
relay. It is safe to remove image-side world-writable workarounds after all
deployed control planes contain the writable-memory ownership fix.
