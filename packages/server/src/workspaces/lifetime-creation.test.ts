import { expect, test } from "bun:test";
import { parseWorkloadTemplate, workloadLifecycle } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { createTestServer } from "../testing/test-server.test";
import { WorkspaceService } from "./service";

const createStore = createTestStoreFactory();

test.each([300, 900])(
  "initial deadline respects the manifest and deployment ceiling of %s seconds",
  async (deploymentDeadlineSeconds) => {
    const f = await createTestServer(await createStore(), { globalActiveWorkspaces: 0 });
    const raw = await Bun.file(new URL("../../../../examples/workloads/finite-process.json", import.meta.url)).json();
    raw.metadata.name = "fixture-echo";
    raw.spec.version = "2.0.0";
    raw.spec.lifecycle = {
      timeouts: { start: "30s", maxAge: "600s", idle: "600s", disconnectGrace: "30s", terminateGrace: "30s" },
    };
    const { manifest, digest } = parseWorkloadTemplate(raw);
    await f.store.upsertTemplate({
      name: manifest.metadata.name,
      version: "2.0.0",
      digest,
      description: null,
      spec: workloadLifecycle(manifest),
      manifest,
    });
    const identity = await f.store.getMachineKeyWithPrincipal(f.keyId);
    if (!identity) throw new Error("Missing test principal");
    const now = new Date();
    const service = new WorkspaceService({
      store: f.store,
      scheduler: f.scheduler,
      limits: DEFAULT_LIMITS,
      deploymentDeadlineSeconds,
      now: () => now,
    });
    const { workspace } = await service.create(
      identity.principal,
      {
        external_id: "bounded-lifetime",
        template: { name: "fixture-echo" },
      },
      "bounded-lifetime",
    );
    const ceiling = new Date(now.getTime() + Math.min(600, deploymentDeadlineSeconds) * 1000);
    expect(workspace.deadlineAt).toEqual(ceiling);
    expect(workspace.lifetime?.ceilingAt).toBe(ceiling.toISOString());
  },
);
