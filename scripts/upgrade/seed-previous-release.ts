// Runs inside a checkout of a previous release, with that release's own store code, so the
// seeded rows are exactly what the release wrote. Prints the seeded identities as JSON.
import { randomUUID } from "node:crypto";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { digestOf, parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { PostgresStore } from "@pstdio/pocketcoder-db";

const url = process.env.SEED_DATABASE_URL as string;
const pepper = process.env.SEED_PEPPER as string;
const store = new PostgresStore(url, "pocketcoder");
const parsed = parseTemplateManifest({
  apiVersion: "pocketcoder.dev/v1alpha1",
  kind: "Template",
  metadata: { name: "upgrade-fixture", description: "seeded by a previous release" },
  spec: {
    version: "1.0.0",
    image: `example.test/upgrade@sha256:${"e".repeat(64)}`,
    harness: { command: ["sleep", "1"] },
    resources: { cpu: "1", memory: "256Mi" },
    services: {},
    persistence: { mounts: [{ name: "worktree", target: "/workspace", maxBytes: 1024, maxFiles: 10 }] },
    outputs: { commit: { type: "gitSha" } },
  },
});
const principal = await store.createPrincipal("upgrade-owner", ["admin"], ["*"]);
const key = issueMachineKey(pepper);
await store.insertMachineKey({
  id: key.id,
  principalId: principal.id,
  secretDigest: key.secretDigest,
  scopes: [],
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
  revokedAt: null,
  lastUsedAt: null,
});
const { row: template } = await store.upsertTemplate({
  name: "upgrade-fixture",
  version: "1.0.0",
  digest: parsed.digest,
  description: null,
  spec: parsed.manifest.spec,
});

async function workspace(externalId: string) {
  const result = await store.insertWorkspace({
    id: randomUUID(),
    principalId: principal.id,
    externalId,
    idempotencyKey: externalId,
    requestDigest: digestOf({ externalId }),
    templateId: template.id,
    templateSnapshot: snapshotOf(parsed),
    launchInput: { code: "opaque" },
    metadata: { seeded: "true" },
    deadlineAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
  });
  if (result.kind === "capacity_exceeded") throw new Error("seed capacity");
  return result.workspace;
}

const ended = await workspace("ended");
const at = new Date();
const message = (messageId: string, content: string, identity?: unknown) =>
  store.appendConversationMessage({
    workspaceId: ended.id,
    messageId,
    role: "assistant",
    content,
    occurredAt: at,
    metadata: { provider: "agentapi" },
    createdAt: at,
    ...(identity ? { identity } : {}),
  } as never);
await message("agentapi:1", "first message from an earlier release");
const conversationId = randomUUID();
// 0.8.1 added request identities; earlier releases keep plain messages only.
const withIdentity = "acceptConversationRequest" in store;
if (withIdentity) {
  const request = {
    schema: "pocketcoder.conversation/v2" as const,
    authority: "external" as const,
    conversation_id: conversationId,
    request_id: randomUUID(),
    turn_id: randomUUID(),
    request_fingerprint: "f".repeat(64),
  };
  await (store as unknown as { acceptConversationRequest: Function }).acceptConversationRequest(ended.id, request, at);
  const event = randomUUID();
  for (const [revision, content] of [
    [1, "Draft"],
    [2, "Draft answer from 0.8.1"],
  ] as const)
    await message(`answer:${revision}`, content, {
      ...request,
      event_id: event,
      message_id: "answer",
      sequence: 0,
      revision,
    });
}
await message("agentapi:2", "second message from an earlier release");
await store.transition(ended.id, { from: ["queued"], to: "canceled", reason: "canceled_by_caller", at });
// 0.8.x preserved workspaces on Kubernetes volumes, a backend 0.9 controllers no longer use.
const storageId = randomUUID();
await store.insertWorkspaceStorage({
  id: storageId,
  workspaceId: ended.id,
  principalId: principal.id,
  providerKind: "kubernetes-pvc",
  providerRef: { claimName: "pc-upgrade-fixture" },
  state: "ready",
  mountManifest: [{ name: "worktree", target: "/workspace", maxBytes: 1024, maxFiles: 10 }],
  logicalBytes: null,
  fileCount: null,
  retainedUntil: null,
  createdAt: at,
  updatedAt: at,
  deletedAt: null,
  lastErrorCode: null,
} as never);
const checkpointId = randomUUID();
await store.insertCheckpoint({
  id: checkpointId,
  workspaceId: ended.id,
  principalId: principal.id,
  storageId,
  parentCheckpointId: null,
  state: "ready",
  reasonCode: null,
  providerKind: "kubernetes-pvc",
  providerRef: { claimName: "pc-upgrade-fixture", snapshot: "old" },
  templateSnapshot: snapshotOf(parsed),
  templateDigest: parsed.digest,
  sourceProvenance: null,
  manifest: null,
  manifestDigest: null,
  logicalBytes: 1,
  storedBytes: 1,
  fileCount: 1,
  conversationRestore: "supported",
  label: null,
  createdAt: at,
  updatedAt: at,
  readyAt: at,
  expiresAt: null,
  deletedAt: null,
} as never);
const queued = await workspace("queued");
await store.close();
console.log(
  JSON.stringify({
    principalId: principal.id,
    token: key.token,
    keyId: key.id,
    endedWorkspaceId: ended.id,
    queuedWorkspaceId: queued.id,
    checkpointId,
    conversationId: withIdentity ? conversationId : null,
  }),
);
