import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPGliteFixture, insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { stopWorkspaceProvider } from "@pstdio/pocketcoder-runtime-core";
import { KubernetesDriver } from "./kubernetes";
import { kubectl } from "./kubernetes-command";

const namespace = process.env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
const run = (args: string[]) => kubectl("kubectl", namespace, args);

describe.skipIf(process.env.POCKETCODER_KUBERNETES_CONFORMANCE !== "1")("quota-denied Job cancellation", () => {
  test("fences a never-admitted Job and saves proof before releasing its provider", async () => {
    const f = await createPGliteFixture("pc-empty-job");
    let name: string | undefined;
    try {
      const workspace = await insertTestWorkspace(f, randomUUID());
      const driver = new KubernetesDriver({ namespace, captureTerminationEvidence: true });
      const ref = await driver.create({
        workspace,
        mounts: [],
        secrets: [],
        input: {
          workspace_id: workspace.id,
          server_url: "http://controller.test",
          registration_secret: randomUUID(),
          template_digest: workspace.templateDigest,
          template_name: f.template.name,
          template_version: f.template.version,
          launch_mode: "create",
        },
      });
      name = ref.id;
      await f.store.updateWorkspace(workspace.id, { providerKind: "kubernetes", providerRef: ref }, new Date());
      await f.store.transition(workspace.id, { from: ["queued"], to: "provisioning", at: new Date() });
      await f.store.transition(workspace.id, {
        from: ["provisioning"],
        to: "terminating",
        reason: "launch_failed",
        patch: { terminalIntent: "failed" },
        at: new Date(),
      });
      const deadline = Date.now() + 10_000;
      while (true) {
        const job = JSON.parse(await run(["get", "job", name, "-o", "json"]));
        if (job.status?.startTime) break;
        if (Date.now() >= deadline) throw new Error("Job controller did not process the quota-denied Job.");
        await Bun.sleep(100);
      }
      const pods = JSON.parse(await run(["get", "pods", "-l", `job-name=${name}`, "-o", "json"]));
      expect(pods.items).toHaveLength(0);
      expect((await f.store.countActive()).global).toBe(1);
      const current = await f.store.getWorkspace(workspace.id);
      if (!current) throw new Error("Workspace disappeared.");
      await stopWorkspaceProvider(f.store, driver, current, 1, new Date(), false);
      const proof = await driver.terminationEvidence(ref);
      expect(proof?.pods).toEqual([]);
      const job = JSON.parse(await run(["get", "job", name, "-o", "json"]));
      expect(job.spec.suspend).toBe(true);
      expect(job.status.conditions).toContainEqual(expect.objectContaining({ type: "Suspended", status: "True" }));
      expect((await f.store.getWorkspace(workspace.id))?.providerRef?.terminationEvidence).toEqual(proof);
      await stopWorkspaceProvider(f.store, driver, current, 1, new Date());
      expect(await run(["get", "job", name, "--ignore-not-found", "-o", "name"])).toBe("");
      await f.store.transition(workspace.id, { from: ["terminating"], to: "failed", at: new Date() });
      expect((await f.store.countActive()).global).toBe(0);
    } finally {
      if (name) {
        await run(["delete", "job", name, "--ignore-not-found", "--wait=true"]);
        await run(["delete", "secret", `${name}-input`, "--ignore-not-found"]);
      }
      await f.dispose();
    }
  }, 30_000);
});
