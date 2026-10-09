import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NODE_IMAGE = "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5";
const testFiles = ["packages/drivers/src/kubernetes/kubernetes-registry.conformance.test.ts"];
const existingNode = process.env.POCKETCODER_KIND_NODE;

async function command(args: string[], env = process.env, timeoutMs = 180000) {
  const child = Bun.spawn(args, { env, stdout: "inherit", stderr: "inherit" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const code = await child.exited;
    if (code) throw new Error(`${args[0]} ${args[1]} exited ${code}.`);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  if (existingNode) {
    if (!process.env.KUBECONFIG) throw new Error("An existing kind node requires its isolated KUBECONFIG.");
    await command([process.execPath, "--no-env-file", "test", ...testFiles, ...process.argv.slice(2)]);
    return;
  }
  const kind = process.env.POCKETCODER_KIND_BIN ?? "kind";
  const name = `pocketcoder-registry-${randomUUID().slice(0, 8)}`;
  const directory = await mkdtemp(join(tmpdir(), "pc-kind-conformance-"));
  const kubeconfig = join(directory, "kubeconfig");
  try {
    await command([
      kind,
      "create",
      "cluster",
      "--name",
      name,
      "--image",
      NODE_IMAGE,
      "--kubeconfig",
      kubeconfig,
      "--wait",
      "60s",
    ]);
    await command([process.execPath, "--no-env-file", "test", ...testFiles, ...process.argv.slice(2)], {
      ...process.env,
      KUBECONFIG: kubeconfig,
      POCKETCODER_KIND_NODE: `${name}-control-plane`,
    });
  } finally {
    try {
      await command([kind, "delete", "cluster", "--name", name, "--kubeconfig", kubeconfig]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

await main();
