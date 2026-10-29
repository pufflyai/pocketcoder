# Upgrading from coder-lite

This is the complete public rename delta from coder-lite to PocketCoder. The
table is frozen through PocketCoder 0.9: no additional coder-lite names will be
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

## Upgrade from 0.8.x on PostgreSQL

A 0.8.x PostgreSQL database upgrades in place. Keep the same database, schema and
auth pepper. You do not need a fresh controller, new principals or new keys.

1. Back up the database with your provider's tools.
2. Stop the 0.8.x controller.
3. Run the new release's migration with the existing settings:

   ```sh
   POCKETCODER_DATABASE_URL=... POCKETCODER_DATABASE_SCHEMA=pocketcoder pcd db migrate
   ```

   It applies the 0.9 migrations under an advisory lock. Then it converts the
   conversation history into documents, one workspace per transaction, and prints
   its progress. If it stops, run it again: it continues where it stopped, and a
   finished conversion changes nothing.
4. Start the 0.9 controller with `POCKETCODER_DATABASE_URL`, the same
   `POCKETCODER_AUTH_PEPPER`, and a new private volume for
   `POCKETCODER_JOURNAL_DIR` (see [deployment](deployment.md#store)).

What the upgrade does:

- **0.8.1 history.** 0.8.1 shipped `20261013125843_tiny_marvel_zombies`, which the
  0.9 chain does not contain. 0.9 has the same statements in
  `20261014100009_marvelous_praxagora`, plus two reason-code constraints. The
  migrator detects the 0.8.1 migration, applies only the two missing constraints
  and records `marvelous_praxagora` with its real hash. No shipped migration
  changes.
- **0.7.1 JSON.** 0.7.1 stored some JSON objects as text inside jsonb strings, and
  0.8.x decoded them on read. The upgrade decodes them once in place: template
  specs, workspace snapshots, metadata, storage and checkpoint references, and
  conversation metadata and identities.
- **Conversation history** becomes [conversation documents](api.md#durable-conversation-history).
  Turns with a request identity join the document of their conversation.
  Messages without one become a document of their workspace, flagged `legacy`
  (ADR 001 forbids made-up identities). The workspace history keeps its order.

What carries over:

| Carried over | Not carried over |
|---|---|
| Principals and machine keys (same pepper) | Old checkpoints on 0.8 storage such as `kubernetes-pvc`: restore and resume return `409 checkpoint.unsupported` |
| Templates and template status | Old workspaces do not resume; they stay readable |
| Admission state and queued workspaces | |
| Warm-pool configuration (from the environment) | |
| Conversation history and request receipts | |

**Custom tables.** Some consumers added their own tables to the `pocketcoder`
schema, for example through an admission migration patch. 0.9 does not read or
change them, but they share the schema's name space. Before upgrading, list them:

```sql
SELECT tablename FROM pg_tables WHERE schemaname = 'pocketcoder' ORDER BY tablename;
```

Compare the list with the tables of a scratch database that `pcd db migrate` just
created. Move every extra table to the consumer's own schema, or drop it once its
data is no longer needed.

PGlite data folders from 0.9 candidates open with the 0.9 release directly; their
history converts the first time the store opens. See the
[release checklist](release.md) for the rule that every release upgrades the
previous one in place.

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
