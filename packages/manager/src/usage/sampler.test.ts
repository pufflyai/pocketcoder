import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagerStore } from "../database/store";
import { usageSampler } from "./sampler";

test("failed real Kubernetes observations are durable gaps; retries and concurrent sampling do not duplicate them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-usage-unavailable-"));
  const prior = process.env.KUBECONFIG;
  const store = await ManagerStore.create();
  const sampler = usageSampler(store);
  try {
    const path = join(directory, "kubeconfig");
    await writeFile(
      path,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: "unavailable", cluster: { server: "https://127.0.0.1:9" } }],
        contexts: [{ name: "unavailable", context: { cluster: "unavailable", user: "no-authority" } }],
        "current-context": "unavailable",
        users: [{ name: "no-authority", user: {} }],
      }),
      { mode: 0o600 },
    );
    process.env.KUBECONFIG = path;
    const config = { controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`, runtimeClassName: "pc-runc" };
    const { account, operation } = await store.createAccount(
      "failed-sample",
      { name: "usage" },
      config,
      new Date(Date.now() + 60_000),
    );
    const provisioning = await store.createAccount(
      "not-ready",
      { name: "provisioning" },
      config,
      new Date(Date.now() + 60_000),
    );
    await store.finishAccount(account.id, operation.id);
    const at = new Date();
    await Promise.all([sampler.sample(at), sampler.sample(at)]);
    await sampler.sample(at);
    expect(await store.getUsage(account.id, new Date(+at + 1))).toMatchObject({
      estimated_workspace_seconds: null,
      observed_peak: null,
      volume_bytes: null,
      sampled_at: at.toISOString(),
      coverage: { recorded_samples: 1, workspace_samples: 0, volume_samples: 0 },
    });
    expect((await store.getUsage(provisioning.account.id)).coverage.recorded_samples).toBe(0);
  } finally {
    await sampler.close();
    await store.close();
    if (prior === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
