import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagerStore } from "../database/store";
import { usageSampler } from "./sampler";

function childProcesses() {
  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return "unavailable";
    }
  };
  const root = `/proc/${process.pid}/task`;
  const children = new Set(
    readdirSync(root).flatMap((id) => read(`${root}/${id}/children`).split(/\s+/).filter(Boolean)),
  );
  return [...children].map((id) => ({
    id,
    command: read(`/proc/${id}/cmdline`).replaceAll("\0", " "),
    state: read(`/proc/${id}/status`)
      .split("\n")
      .find((line) => line.startsWith("State:")),
    wait: read(`/proc/${id}/wchan`),
  }));
}

test("failed real Kubernetes observations are durable gaps; retries and concurrent sampling do not duplicate them", async () => {
  let phase = "setup";
  const diagnostic =
    process.platform === "linux"
      ? setTimeout(() => console.log("Pending Kubernetes usage sample", { phase, children: childProcesses() }), 3000)
      : undefined;
  const directory = await mkdtemp(join(tmpdir(), "pc-usage-unavailable-"));
  const prior = process.env.KUBECONFIG;
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const unavailableServer = `https://127.0.0.1:${listener.port}`;
  listener.stop(true);
  const store = await ManagerStore.create();
  const sampler = usageSampler(store);
  try {
    const path = join(directory, "kubeconfig");
    await writeFile(
      path,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: "unavailable", cluster: { server: unavailableServer } }],
        contexts: [{ name: "unavailable", context: { cluster: "unavailable", user: "no-authority" } }],
        "current-context": "unavailable",
        // An invalid fixture token prevents an interactive credential prompt.
        users: [{ name: "no-authority", user: { token: "invalid-fixture-token" } }],
      }),
      { mode: 0o600 },
    );
    process.env.KUBECONFIG = path;
    const config = { controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`, runtimeClassName: "pc-runc" };
    const { account, operation } = await store.createAccount(
      "failed-sample",
      { name: "usage" },
      () => config,
      new Date(Date.now() + 60_000),
    );
    const provisioning = await store.createAccount(
      "not-ready",
      { name: "provisioning" },
      () => config,
      new Date(Date.now() + 60_000),
    );
    await store.finishAccount(account.id, operation.id);
    const at = new Date();
    phase = "concurrent sample";
    await Promise.all([sampler.sample(at), sampler.sample(at)]);
    phase = "repeated sample";
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
    clearTimeout(diagnostic);
    await sampler.close();
    await store.close();
    if (prior === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
