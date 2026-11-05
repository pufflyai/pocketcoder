# Managed contract v1

The internal `@pstdio/pocketcoder-contracts` package exports `managed`, the versioned integration design
for PC-162 draft revision 2. `MANAGED_CONTRACT_REVISION` is
`pocketcoder.managed/v1`. The authoritative Zod types live under
`packages/contracts/src/sessions` and `budgets`. These are contracts for later
session and accounting work, not a claim that logical sessions or budgets run now.

| Artifact | Purpose |
| --- | --- |
| [JSON Schema](../packages/contracts/src/sessions/generated/contracts.schema.json) | Named strict input/resource definitions, Draft 2020-12 |
| [OpenAPI](../packages/contracts/src/sessions/generated/openapi.json) | Proposed consumer routes; every operation has `x-shipped: false` |
| [Parent examples](../packages/contracts/src/sessions/fixtures/parent-revision-2.json) | One example per parent definition |
| [Collection examples](../packages/contracts/src/sessions/fixtures/collection-v1.json) | Pending, empty complete, zero-file partial and loss |
| [Fingerprint vectors](../packages/contracts/src/sessions/fixtures/fingerprints-v1.json) | Portable canonical UTF-8 JSON and SHA-256 expectations |
| [Store ports](../packages/runtime-contracts/src/stores/managed-sessions.ts) | Transaction, authority, input pins, canonical requests, bindings, observations and history |
| [Budget ports](../packages/runtime-contracts/src/stores/managed-budgets.ts) | Invocation reservations, usage evidence, uncertain liability and cleanup settlement |

Run `bun run contracts:generate` after changing a schema. `bun run check` rejects
stale artifacts. Runtime schema tests cover cross-field identity, event revisions,
terminal/cancel consistency and collection invariants beyond structural JSON
validation. Generate clients from this explicitly unshipped API only as design
work; do not send these routes to current servers.

## Contract and physical API map

| Parent concept | Versioned name | Current physical foundation / next owner |
| --- | --- | --- |
| Immutable execution profile | `ExecutionProfile` | PC-164 provisioning; PC-137 credential authorization/delivery |
| Logical identity and state | `SessionCreate`, `Session` | PC-164; canonical conversation owns its transcript |
| Durable logical acceptance | `RequestInput`, `Request` | PC-166 extends `conversation_requests`; current `/workspaces/{id}/executions` requires a physical envelope |
| Cancel and close | `CancelCommand`, `CancelReceipt` | PC-172 composes existing targeted execution cancellation and workspace lifecycle |
| Immutable session inputs | `InputUpload`, `InputObject`, `InputReference` | PC-165 extends existing input owner; current upload paths are workspace-scoped |
| Retained result and zero-file receipt | `CollectionResult`, `ExportObject`, `ExportPage` | PC-165 maps `WorkloadExportReference`; PC-131 implements finite physical collection |
| Retained history snapshot | `HistoryPage` | PC-173 reuses canonical `ConversationRecordDocument`; outer fields are exactly `records`, `nextCursor`, `eventCursor` |
| Ordered observations | `RuntimeEvent` | PC-164 writes revisions/observations; PC-173 adds snapshot/replay readers |
| Budget scopes and policies | `BudgetPolicyWrite`, `BudgetPolicy`, `BudgetUsage` | PC-167/168/169/170; no consumer-writable usage settlement |
| Runtime cleanup evidence | `CleanupReceipt` | Trusted accounting input, separate from model usage evidence |
| Workspace service tool | `ServiceStart`, `ServiceReceipt` | PC-133 ships supervisor-local `service start/stop/status`; no public remote shell |
| Bounded physical extension | `LifetimeExtension`, `LifetimeReceipt` | PC-133 ships `/workspaces/{id}/lifetime`; camel-case request/receipt fields |
| Browser grants | Existing physical preview grant schemas | PC-138 ships workspace/incarnation grants; PC-139 resolves logical sessions |

Logical `requestId` is caller-selected and session-scoped. Physical execution
references use the server-allocated `turnId` as their internal request ID. PC-166
must map those identities on the existing canonical row. Two sessions with the
same public request ID must not share one execution claim.

Logical `versionId` is an opaque UUID. Physical input references use their existing
object/version identities; physical export `objectVersion` is a content digest.
PC-165 must persist their logical mapping rather than reinterpret the digest as a
UUID. The collection facade returns the existing immutable `manifestDigest` as an
opaque commitment. It maps publication/expiry/deletion to object availability and
preserves manifest completeness/errors even for an empty object list. Physical
`publishedAt` maps to logical `settledAt`; logical observation `revision` is owned
by the canonical request transaction. Staging `cleanupState` does not claim model
usage settlement or provider termination.

## Acceptance and recovery ownership

One session-row lock and transaction cover authority recheck, same-ID replay,
ready-file validation/pins, queue count/byte charges, acceptance sequence, turn ID,
canonical request write, revision and retained observation. Replays precede quota
consumption and input revalidation, but never precede current authorization.
Accepted requests can exist without compute or a physical execution envelope.
There is no second mutable request registry, dispatcher or transcript.

Only the existing execution dispatcher claims the physical envelope. Envelope
creation rechecks binding revision, authority, capability and dispatch deadline.
A claimed attempt with an unknown outcome stays `checking_outcome` until the old
producer is reconciled or fenced and proved lost. Replacement alone never permits
another dispatch. Terminal execution and collection are separate: the serial
barrier and queue charges remain until collection settles or bounded partial/lost
evidence is committed.

Terminal facts, canonical history record, request revision and observation commit
in one transaction before producer acknowledgement. Managed recovery must replace
the legacy eager interrupted-record shortcut, not invent a successful reply on
restart. Retained observations are not another execution authority. Snapshot pages
and their event watermark use one consistent snapshot with a stable upper bound.
PC-164/166/171/172/173 implement these ports and crash cuts; this change provides
and tests their contract only.

## Fingerprint and placement

`fingerprintRequest` uses existing `canonicalJson` and `digestOf`: recursively sorted
keys, preserved array order, UTF-8 JSON, safe integers, valid Unicode, no message
whitespace or Unicode normalization. Inputs include session/request identity,
pinned profile ID/revision, exact message, ordered immutable references and
absolute dispatch deadline. The message limit is 256 KiB of UTF-8 as well as the
character bound. Golden vectors distinguish attachment order, composed/decomposed
Unicode, whitespace, profile revisions and deadlines. Clients retry the original
body and do not supply a physical fingerprint.

Profile scopes cannot be omitted or duplicated. The provisioning owner must enforce
installation scope membership and profile grants; an arbitrary budget scope never
authorizes sharing. `managedPlacement` describes compatibility from principal and
the complete immutable profile revision. A credential binding makes placement
exclusive to the logical session. Credential-free sessions may share only with
compatible profile/budget/isolation bindings. This pure key is not an allocation
or authorization API. Credentials stay physically workspace-scoped, expire no
later than that workspace, and must be reissued after replacement. They never
appear in these resources, templates, history, events or logs.

Capability admission still uses installed producer evidence and `workloadAdmission`.
Declaring a schema or capability name never enables an unsupported adapter.
