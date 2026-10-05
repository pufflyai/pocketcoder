import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import { fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import { stopWorkspaceProvider } from "./provider-termination";

async function fixture() {
  const store = new MemoryStore();
  const principal = await store.createPrincipal("cleanup", ["admin"], ["*"]);
  const parsed = fixtureTemplateEcho();
  const { row: template } = await store.upsertTemplate({
    name: parsed.manifest.metadata.name,
    version: parsed.manifest.spec.version,
    digest: parsed.digest,
    description: null,
    spec: parsed.manifest.spec,
  });
  const id = randomUUID();
  const now = new Date();
  const result = await store.insertWorkspace({
    id,
    principalId: principal.id,
    externalId: id,
    idempotencyKey: id,
    requestDigest: digestOf({ id }),
    templateId: template.id,
    templateSnapshot: snapshotOf(parsed),
    launchInput: {},
    metadata: {},
    deadlineAt: new Date(now.getTime() + 60000),
    createdAt: now,
  });
  if (result.kind === "capacity_exceeded") throw new Error("unexpected capacity");
  await store.updateWorkspace(
    id,
    {
      providerKind: "kubernetes",
      providerRef: {
        kind: "kubernetes",
        id: "job",
        namespace: "original",
        inputSecret: "job-input",
      },
    },
    now,
  );
  const workspace = await store.getWorkspace(id);
  if (!workspace) throw new Error("missing workspace");
  return { store, workspace, now };
}

test.each(["matching", "absent", "wrong-provider", "wrong-namespace", "wrong-kind"] as const)(
  "concurrent finalization recovers only %s runtime proof",
  async (proofState) => {
    const { store, workspace, now } = await fixture();
    const proof = { job: { metadata: { uid: "job-uid" } }, pods: [{ metadata: { uid: "pod-uid" } }] };
    let removed = false;
    const driver = {
      stop: async () => {
        await store.updateWorkspace(
          workspace.id,
          {
            providerKind: proofState === "wrong-kind" ? "docker" : "kubernetes",
            providerRef: {
              ...workspace.providerRef,
              id: proofState === "wrong-provider" ? "other" : "job",
              namespace: proofState === "wrong-namespace" ? "other" : "original",
              ...(proofState !== "absent" ? { terminationEvidence: proof } : {}),
            },
          },
          now,
        );
        throw new Error("Termination provider disappeared without evidence");
      },
      terminationEvidence: async () => null,
      remove: async () => {
        removed = true;
      },
    };
    const stopping = stopWorkspaceProvider(store, driver, workspace, 1, now);
    if (proofState === "matching") await expect(stopping).resolves.toBeUndefined();
    else await expect(stopping).rejects.toThrow("Termination provider disappeared");
    expect(removed).toBe(proofState === "matching");
    if (proofState === "matching")
      expect((await store.getWorkspace(workspace.id))?.providerRef?.terminationEvidence).toEqual(proof);
  },
);

test("proof recovery still honors callers that retain the provider", async () => {
  const { store, workspace, now } = await fixture();
  await store.updateWorkspace(
    workspace.id,
    { providerRef: { ...workspace.providerRef, terminationEvidence: { job: { metadata: { uid: "job-uid" } } } } },
    now,
  );
  let removed = false;
  const driver = {
    stop: async () => {
      throw new Error("NotFound");
    },
    remove: async () => {
      removed = true;
    },
  };
  await stopWorkspaceProvider(store, driver, workspace, 1, now, false);
  expect(removed).toBe(false);
});
