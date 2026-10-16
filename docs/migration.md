# Upgrading from coder-lite

This is the complete public rename delta from coder-lite to PocketCoder. The
table is frozen through PocketCoder 1.0: no additional coder-lite names will be
renamed or removed before that release.

| coder-lite | PocketCoder |
|------------|-------------|
| `coder-lite` | `pocketcoder` |
| `CODER_LITE_*` environment variables | `POCKETCODER_*` |
| `coder-lite.dev/v1alpha1` | `pocketcoder.dev/v1alpha1` |
| `X-Coder-Lite-Signature` | `X-PocketCoder-Signature` |
| `/run/coder-lite/input` | `/run/pocketcoder/input` |
| `/opt/coder-lite/ctl.js` | `/opt/pocketcoder/cli/index.js` |
| `coder-lite-agent` binary | `pocketcoder-supervisor` |

Apply the rename in one pass across deployment scripts, Compose/Kubernetes
manifests, environment and secret names, template manifests, workspace images,
event signature verification, control-plane invocations, and backend adapters.
Do not mix old and new identifiers within one deployment.

After the replacement:

1. Pin the server image and every workspace image by digest.
2. Start the server with a supported data folder; migrations run on startup.
3. Validate every reviewed template.
4. Run `pcd doctor --template <production-template>`.
5. Confirm a signed event using `X-PocketCoder-Signature`.

`doctor: ok` now means a non-root workspace passed its declared in-memory path
write checks and completed a correlated request/response turn through the
relay. It is safe to remove image-side world-writable workarounds after all
deployed control planes contain the writable-memory ownership fix.

## Embedded database cutover

The embedded database opens only PGlite data folders. It does not convert an
existing PostgreSQL install in place. Keep the stopped source database, original
auth pepper, event-signing identity and required checkpoint bytes intact until
the offline export/import flow is available and verified. A fresh `pc_data`
folder is a new install, not a migration of existing state.

## Alpha templates to canonical workloads

`pocketcoder.dev/v1` replaces the alpha `agent` versus `harness` split with pinned
adapters and operations. This is a new immutable format. There is no automatic
conversion, runtime inheritance, or compatibility wrapper. Author and build a new
manifest with a new version, explicit limits, actual image/runtime/adapter pins,
and reviewed credential slots. Validate and render it offline; publish it only
when the deployment has installed and qualified the required runtime profile.
The current alpha controller rejects the new format at publication/startup import.

The canonical schema rejects alpha fields such as `agent`, `harness` and
`checkpointHook`. Changing only `apiVersion` cannot migrate an alpha manifest.
Generic commands become process adapters; plain HTTP transport can use a service
profile without an agent. Pi and AgentAPI are optional adapters in the same schema.
Build-time configuration becomes immutable image/template content. Never convert a
standing secret into an environment literal; bind a versioned trusted credential
policy and deliver only workspace-scoped credentials that expire with the runtime.

Saved alpha snapshots without a format discriminator remain identified as
`pocketcoder.dev/v1alpha1`. `inspectTemplateSnapshot(snapshot, supportedFormats)`
returns an explicit supported/unsupported result without changing their content
or digest. Canonical snapshots store their format and full manifest and verify
that name, version and digest match. Unknown, invalid and unsupported snapshots
are rejected. A format result is not permission to run a profile: installed
producer/storage identities, capability checks and limits still apply.

Do not rewrite historical snapshots, retarget accepted file or execution references,
or reinterpret an old digest as the new format. Existing alpha runtimes continue
using their original contract. A restored runtime has a new workspace identity
and needs fresh inputs and authority under the later runtime gates. This ticket
introduces no database migration, production cutover or deployment qualification.
