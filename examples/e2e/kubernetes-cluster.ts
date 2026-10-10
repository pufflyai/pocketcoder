import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command } from "./local-process";

const NODE_IMAGE = "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5";
export const ROOT = resolve(import.meta.dir, "../..");

export async function createKubernetesCluster() {
  const name = `pc-restore-${randomUUID().slice(0, 8)}`;
  const directory = await mkdtemp(join(tmpdir(), "pc-kubernetes-"));
  const kubeconfig = join(directory, "kubeconfig");
  const config = join(directory, "kind.yaml");
  const images: string[] = [];
  const env = { KUBECONFIG: kubeconfig };
  async function run(args: string[], input?: string, extraEnv: Record<string, string> = {}) {
    const child = Bun.spawn(args, {
      cwd: ROOT,
      env: { ...process.env, ...env, ...extraEnv },
      stdin: input === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code) throw new Error(`${args[0]} ${args[1]} failed: ${stderr.trim().slice(0, 2000)}`);
      if (args[0] === "bun" && args[1] === "test") return `${stdout}${stderr}`.trim();
      return stdout.trim();
    } finally {
      clearTimeout(timeout);
    }
  }
  const kube = (args: string[], input?: string) => run(["kubectl", "--request-timeout=30s", ...args], input);
  async function close() {
    await run(["kind", "delete", "cluster", "--name", name, "--kubeconfig", kubeconfig]);
    for (const image of images) await command(["docker", "image", "rm", image], { quiet: true });
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await writeFile(
      config,
      "kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnodes:\n  - role: control-plane\n  - role: worker\n",
    );
    await run([
      "kind",
      "create",
      "cluster",
      "--name",
      name,
      "--image",
      NODE_IMAGE,
      "--config",
      config,
      "--kubeconfig",
      kubeconfig,
      "--wait",
      "60s",
    ]);
    const nodes = [`${name}-control-plane`, `${name}-worker`];
    await kube(["taint", "nodes", nodes[0] as string, "node-role.kubernetes.io/control-plane-"]);
    for (const node of nodes) {
      const record = JSON.parse(await kube(["get", "node", node, "-o", "json"]));
      if (record.spec.providerID) continue;
      const id = await run(["docker", "inspect", "--format", "{{.Id}}", node]);
      await kube([
        "patch",
        "node",
        node,
        "--type=merge",
        "-p",
        JSON.stringify({ spec: { providerID: `kind://docker/${id}` } }),
      ]);
    }
    await kube(
      ["apply", "-f", "-"],
      JSON.stringify({
        apiVersion: "node.k8s.io/v1",
        kind: "RuntimeClass",
        metadata: { name: "pc-runc" },
        handler: "runc",
      }),
    );
    await writeFile(
      join(directory, "internal-kubeconfig"),
      await run(["kind", "get", "kubeconfig", "--name", name, "--internal"]),
      { mode: 0o600 },
    );
    async function buildImage(role: "workspace" | "server") {
      const tag = `pocketcoder-${role}:${name}`;
      images.push(tag);
      if (role === "workspace") {
        await command(
          ["bun", "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"],
          { quiet: true },
        );
        await command(["docker", "build", "-t", tag, "deploy/image"], { quiet: true });
      } else {
        await command(["docker", "build", "-f", "deploy/image/server.Dockerfile", "-t", tag, "."], { quiet: true });
      }
      await run(["kind", "load", "docker-image", "--name", name, tag]);
      const reference = `docker.io/library/${tag}`;
      const listing = await run(["docker", "exec", nodes[0] as string, "ctr", "--namespace", "k8s.io", "images", "ls"]);
      const digest = listing
        .split("\n")
        .find((line) => line.startsWith(`${reference} `))
        ?.split(/\s+/)[2];
      if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Loaded image digest is missing");
      const image = `${reference.split(":")[0]}@${digest}`;
      for (const node of nodes)
        await run(["docker", "exec", node, "ctr", "--namespace", "k8s.io", "images", "tag", reference, image]);
      return { image, tag };
    }
    return {
      name,
      directory,
      kubeconfig,
      env,
      nodes,
      kube,
      run,
      buildImage,
      close,
      async echoTemplate(image: string) {
        const template = JSON.parse(await readFile(join(ROOT, "examples/harnesses/echo/template.json"), "utf8"));
        template.spec.image = image;
        return template;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
