import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command } from "./local-process";

// DOKS enforces NetworkPolicy with Cilium, so the managed-account proof runs on it too.
const CHART = "https://helm.cilium.io/cilium-1.20.2.tgz";
const SHA256 = "b2afd87b7f75f875f92a14559f14f59b7babbb479d968e3fd625a20bf30ec20e";
export async function installCilium(kube: (args: string[], input?: string) => Promise<string>) {
  const response = await fetch(CHART);
  if (!response.ok) throw new Error("Pinned Cilium chart download failed");
  const chart = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(chart).digest("hex") !== SHA256) throw new Error("Cilium chart checksum changed");
  const directory = await mkdtemp(join(tmpdir(), "pc-cilium-"));
  try {
    await writeFile(join(directory, "cilium.tgz"), chart);
    // The chart pins every image by digest. A fixed Kubernetes version keeps offline rendering stable.
    const chartPath = join(directory, "cilium.tgz");
    const values = ["--set", "ipam.mode=kubernetes", "--set", "image.pullPolicy=IfNotPresent"];
    const rendered = await command(
      ["helm", "template", "cilium", chartPath, "--namespace", "kube-system", "--kube-version", "1.37.0", ...values],
      { quiet: true },
    );
    await kube(["create", "-f", "-"], rendered.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await kube(["-n", "kube-system", "rollout", "status", "daemonset/cilium", "--timeout=180s"]);
  await kube(["wait", "nodes", "--all", "--for=condition=Ready", "--timeout=120s"]);
}
