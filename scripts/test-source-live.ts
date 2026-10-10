import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NODE_IMAGE = "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5";
const REGISTRY_IMAGE = "registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";

async function command(args: string[], env = process.env, capture = false) {
  const child = Bun.spawn(args, { env, stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
  try {
    const output = capture ? await new Response(child.stdout).text() : "";
    if (await child.exited) throw new Error(`${args[0]} ${args[1]} failed.`);
    return output.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const kind = process.env.POCKETCODER_KIND_BIN ?? "kind";
  const name = `pc-source-${randomUUID().slice(0, 8)}`;
  const registry = `${name}-registry`;
  const existingNode = process.env.POCKETCODER_KIND_NODE;
  if (existingNode && !process.env.KUBECONFIG) throw new Error("An existing kind node needs an isolated KUBECONFIG.");
  const directory = await mkdtemp(join(tmpdir(), "pc-source-live-"));
  const kubeconfig = process.env.KUBECONFIG ?? join(directory, "kubeconfig");
  const node = existingNode ?? `${name}-control-plane`;
  let tag: string | null = null;
  try {
    const result = await Bun.build({ entrypoints: ["packages/supervisor/src/index.ts"], target: "bun" });
    if (!result.success) throw new Error(`Supervisor build failed: ${result.logs}`);
    await Bun.write(join(directory, "supervisor.js"), result.outputs[0]);
    await Bun.write(join(directory, "pocketcoder-supervisor"), Bun.file("deploy/image/pocketcoder-supervisor"));
    await writeFile(
      join(directory, "Dockerfile"),
      `FROM oven/bun:1.4.2
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY supervisor.js /opt/pocketcoder/supervisor.js
COPY pocketcoder-supervisor /usr/local/bin/pocketcoder-supervisor
RUN chmod 0755 /usr/local/bin/pocketcoder-supervisor
ENV HOME=/tmp
WORKDIR /
USER 10001:10001
`,
    );
    const port = 40000 + Math.floor(Math.random() * 20000);
    await command([
      "docker",
      "run",
      "-d",
      "--name",
      registry,
      "--network",
      "host",
      "-e",
      `REGISTRY_HTTP_ADDR=127.0.0.1:${port}`,
      REGISTRY_IMAGE,
    ]);
    tag = `127.0.0.1:${port}/${name}:test`;
    await command(["docker", "build", "-t", tag, directory]);
    await command(["docker", "push", tag]);
    const image = JSON.parse(await command(["docker", "image", "inspect", tag], process.env, true))[0]
      .RepoDigests[0] as string;
    if (!existingNode)
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
    const cluster = existingNode
      ? await command(
          ["docker", "inspect", node, "--format", '{{index .Config.Labels "io.x-k8s.kind.cluster"}}'],
          process.env,
          true,
        )
      : name;
    await command([kind, "load", "docker-image", tag, "--name", cluster]);
    await command(["docker", "exec", node, "ctr", "-n", "k8s.io", "images", "tag", tag, image]);
    const host =
      process.platform === "linux"
        ? await command(
            ["docker", "inspect", node, "--format", "{{.NetworkSettings.Networks.kind.Gateway}}"],
            process.env,
            true,
          )
        : "host.docker.internal";
    await command(
      [
        process.execPath,
        "--no-env-file",
        "test",
        process.argv.includes("--runtime")
          ? "packages/server/src/testing/runtime-credential.conformance.test.ts"
          : "packages/server/src/testing/private-source.conformance.test.ts",
        ...process.argv.slice(2).filter((arg) => arg !== "--runtime"),
      ],
      {
        ...process.env,
        KUBECONFIG: kubeconfig,
        POCKETCODER_SOURCE_TEST_IMAGE: image,
        POCKETCODER_SOURCE_TEST_HOST: host,
      },
    );
  } finally {
    try {
      if (!existingNode) await command([kind, "delete", "cluster", "--name", name, "--kubeconfig", kubeconfig]);
    } finally {
      await command(["docker", "rm", "-f", registry]);
      if (tag) await command(["docker", "image", "rm", tag]);
      await rm(directory, { recursive: true, force: true });
    }
  }
}

await main();
