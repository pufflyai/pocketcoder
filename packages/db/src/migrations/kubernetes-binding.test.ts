import { expect, test } from "bun:test";
import { createPGliteFixture, insertTestWorkspace } from "../test-fixtures";
import { bindKubernetesJob } from "./kubernetes-binding";
import { migrateDatabase } from "./migrator";

test("binding a verified original UID preserves the reference and unblocks migration", async () => {
  const f = await createPGliteFixture("bind-kubernetes");
  try {
    const workspace = await insertTestWorkspace(f, "legacy");
    const ref = {
      kind: "kubernetes",
      id: `pocketcoder-${workspace.id}`,
      namespace: "alpha",
      inputSecret: "original-input",
    };
    await f.store.transition(workspace.id, {
      from: ["queued"],
      to: "provisioning",
      at: new Date(),
      patch: { providerKind: "kubernetes", providerRef: ref },
    });
    await f.store.transition(workspace.id, { from: ["provisioning"], to: "terminating", at: new Date() });
    await bindKubernetesJob(
      f.context.sql,
      f.schema,
      { kind: "workspace", id: workspace.id, namespace: "alpha", jobUid: "original-job-uid" },
      async (binding) => {
        expect(binding.providerRef).toEqual(ref);
        expect(binding.templateDigest).toBe(workspace.templateDigest);
      },
    );
    expect((await f.store.getWorkspace(workspace.id))?.providerRef).toEqual({ ...ref, jobUid: "original-job-uid" });
    expect(await migrateDatabase(f.context.sql, undefined, f.schema)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("a warm runtime must bind its original UID before migration", async () => {
  const f = await createPGliteFixture("bind-warm-kubernetes");
  try {
    const id = crypto.randomUUID();
    const at = new Date();
    const ref = { kind: "kubernetes", id: `pocketcoder-pool-${id}`, namespace: "alpha", poolRuntimeId: id };
    await f.store.insertWarmPoolRuntime({
      id,
      templateId: f.template.id,
      templateName: f.template.name,
      templateVersion: f.template.version,
      templateDigest: f.template.digest,
      driverKind: "kubernetes",
      eligibilityFingerprint: "legacy",
      state: "draining",
      providerRef: ref,
      enrollmentDigest: null,
      enrollmentExpiresAt: null,
      workspaceId: null,
      createdAt: at,
      updatedAt: at,
      readyAt: null,
      leasedAt: null,
      failureCode: null,
    });
    await expect(migrateDatabase(f.context.sql, undefined, f.schema)).rejects.toThrow(`warm-runtime ${id}`);
    await bindKubernetesJob(
      f.context.sql,
      f.schema,
      { kind: "warm-runtime", id, namespace: "alpha", jobUid: "original-warm-uid" },
      async (binding) => {
        expect(binding.kind).toBe("warm-runtime");
        expect(binding.providerRef).toEqual(ref);
      },
    );
    expect((await f.store.getWarmPoolRuntime(id))?.providerRef).toEqual({ ...ref, jobUid: "original-warm-uid" });
    expect(await migrateDatabase(f.context.sql, undefined, f.schema)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test.each([
  { name: "different namespace", namespace: "other", storedUid: undefined, error: "namespace does not match" },
  { name: "already bound Job", namespace: "alpha", storedUid: "different-original", error: "already bound" },
])("binding rejects a $name without consulting the provider", async ({ namespace, storedUid, error }) => {
  const f = await createPGliteFixture("bind-kubernetes-rejected");
  try {
    const workspace = await insertTestWorkspace(f, "legacy");
    const ref = { kind: "kubernetes", id: "original", namespace: "alpha", jobUid: storedUid };
    await f.store.updateWorkspace(workspace.id, { providerKind: "kubernetes", providerRef: ref }, new Date());
    await expect(
      bindKubernetesJob(
        f.context.sql,
        f.schema,
        { kind: "workspace", id: workspace.id, namespace, jobUid: "supplied-uid" },
        async () => {
          throw new Error("Provider should not be consulted");
        },
      ),
    ).rejects.toThrow(error);
    expect((await f.store.getWorkspace(workspace.id))?.providerRef).toEqual(JSON.parse(JSON.stringify(ref)));
  } finally {
    await f.dispose();
  }
});
