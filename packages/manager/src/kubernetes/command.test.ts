import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kube } from "./command";

test("Kubernetes commands use the kubeconfig selected after the manager starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-manager-kubeconfig-"));
  const prior = process.env.KUBECONFIG;
  try {
    const path = join(directory, "kubeconfig");
    await writeFile(
      path,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: "isolated", cluster: { server: "https://127.0.0.1:9" } }],
        contexts: [{ name: "finite-manager-fixture", context: { cluster: "isolated", user: "no-authority" } }],
        "current-context": "finite-manager-fixture",
        users: [{ name: "no-authority", user: {} }],
      }),
      { mode: 0o600 },
    );
    process.env.KUBECONFIG = path;
    expect(await kube(["config", "current-context"])).toBe("finite-manager-fixture");
  } finally {
    if (prior === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = prior;
    await rm(directory, { recursive: true, force: true });
  }
});
