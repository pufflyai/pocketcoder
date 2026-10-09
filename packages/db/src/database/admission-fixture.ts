import { randomUUID } from "node:crypto";
import { digestOf, parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { PGliteStore } from "../store";

export async function inspectAdmission(store: PGliteStore) {
  const empty = await store.readAdmissionSnapshot();
  const principal = await store.createPrincipal("admission", ["admin"], ["*"]);
  const parsed = parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "admission" },
    spec: {
      version: "1.0.0",
      image: `example.test/admission@sha256:${"d".repeat(64)}`,
      harness: { command: ["sleep", "1"] },
      resources: { cpu: "1", memory: "256Mi" },
    },
  });
  const { row: template } = await store.upsertTemplate({
    name: parsed.manifest.metadata.name,
    version: parsed.manifest.spec.version,
    digest: parsed.digest,
    description: null,
    spec: parsed.manifest.spec,
  });
  const at = new Date("2026-01-01T00:00:00Z");
  const inserted = await store.insertWorkspace({
    id: randomUUID(),
    principalId: principal.id,
    externalId: "admission",
    idempotencyKey: "admission",
    requestDigest: digestOf({ admission: true }),
    templateId: template.id,
    templateSnapshot: snapshotOf(parsed),
    metadata: {},
    launchInput: { task: "admission" },
    createdAt: at,
    deadlineAt: new Date(at.getTime() + 60_000),
  });
  if (inserted.kind === "capacity_exceeded") throw new Error("fixture queue is full");
  const queued = await store.readAdmissionSnapshot();
  const runtimeId = randomUUID();
  await store.insertWarmPoolRuntime({
    id: runtimeId,
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    templateDigest: template.digest,
    driverKind: "docker",
    eligibilityFingerprint: "sha256:eligible",
    state: "ready",
    providerRef: { kind: "docker", id: "warm-provider" },
    enrollmentDigest: null,
    enrollmentExpiresAt: null,
    workspaceId: null,
    createdAt: at,
    updatedAt: at,
    readyAt: at,
    leasedAt: null,
    failureCode: null,
  });
  const claim = await store.claimWarmPoolRuntime({
    workspace: inserted.workspace,
    driverKind: "docker",
    eligibilityFingerprint: "sha256:eligible",
    registrationDigest: new Uint8Array([0, 255, 92, 34]),
    registrationExpiresAt: new Date(at.getTime() + 60_000),
    at,
  });
  if (!claim || "kind" in claim) throw new Error("fixture runtime was not claimed");
  const admitted = await store.readAdmissionSnapshot();
  return {
    emptyQueue: empty.queued.length === 0 && empty.queuedCount === 0 && empty.counts.global === 0,
    queuedWorkspace: queued.queued.length === 1 && queued.queued[0]?.id === inserted.workspace.id,
    activeCounts:
      admitted.queued.length === 0 &&
      admitted.counts.global === 1 &&
      admitted.counts.byPrincipal[principal.id] === 1 &&
      admitted.counts.byTemplate[template.name] === 1,
    warmClaim: claim.runtime.id === runtimeId && claim.workspace.state === "provisioning",
    typedDate: claim.workspace.updatedAt instanceof Date && claim.workspace.updatedAt.getTime() === at.getTime(),
    typedBinary:
      claim.workspace.registrationDigest instanceof Uint8Array &&
      Buffer.from(claim.workspace.registrationDigest).equals(Buffer.from([0, 255, 92, 34])),
  };
}
