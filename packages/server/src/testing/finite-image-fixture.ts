import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseWorkloadTemplate, sha256Hex } from "@pstdio/pocketcoder-contracts";
import { dockerCommand, serviceProbeImage } from "./service-image-fixture";

export async function finiteImageFixture(root: string) {
  await mkdir(root, { recursive: true });
  const compiled = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../../supervisor/src/index.ts")],
    target: "bun",
    outdir: root,
  });
  if (!compiled.success) throw new Error("Supervisor build failed");
  await Bun.write(join(root, "supervisor.js"), Bun.file(join(root, "index.js")));
  const digest = `sha256:${sha256Hex(await Bun.file(join(root, "supervisor.js")).bytes())}`;
  const runtime = { digest, protocol: "pocketcoder.workload/v1" };
  const command = [
    "/usr/local/bin/bun",
    "/opt/pocketcoder/supervisor.js",
    "supervise",
    "--launch-input",
    "/run/pocketcoder/input",
  ];
  const capabilities = [
    "ready-without-task",
    "live-inputs",
    "immutable-inputs",
    "serial-operations",
    "retained-exports",
    "explicit-start",
    "exact-exit",
    "targeted-cancel",
    "stop-before-export",
    "request-lookup",
    "deduplicated-accept",
    "workspace-services",
  ];
  await Bun.write(
    join(root, "workload.json"),
    JSON.stringify({
      format: "pocketcoder.image/v1",
      codeRoots: ["/opt", "/usr", "/bin", "/sbin", "/lib", "/lib64"],
      runtime: {
        ...runtime,
        artifact: "/opt/pocketcoder/supervisor.js",
        command,
        entrypoint: ["/usr/local/bin/docker-entrypoint.sh"],
        capabilities,
      },
      adapters: {
        main: {
          kind: "process",
          digest,
          protocol: "pocketcoder.process/v1",
          artifact: "/opt/pocketcoder/supervisor.js",
          capabilities,
          command: ["/usr/local/bin/bun", "/opt/pocketcoder/supervisor.js"],
          environment: [],
        },
      },
    }),
  );
  await Bun.write(
    join(root, "Dockerfile"),
    `FROM ${serviceProbeImage}\nCOPY supervisor.js workload.json /opt/pocketcoder/\n`,
  );
  const tag = `pocketcoder-finite-proof:${randomUUID()}`;
  await dockerCommand("build", "-q", "-t", tag, root);
  const image = `${tag}@${await dockerCommand("image", "inspect", "--format", "{{.Id}}", tag)}`;
  const source = await Bun.file(resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json")).json();
  source.metadata.name = "finite-export-proof";
  source.spec.image = image;
  source.spec.runtime = runtime;
  source.spec.lifecycle = {
    timeouts: { start: "30s", idle: "300s", maxAge: "300s", disconnectGrace: "30s", terminateGrace: "1s" },
  };
  // Twenty fixture workspaces fit the measured four-CPU Docker allocation.
  source.spec.resources = { cpu: "0.2", memory: "256Mi" };
  source.spec.network = { mode: "unrestricted" };
  source.spec.adapters.main = {
    kind: "process",
    digest,
    protocol: "pocketcoder.process/v1",
    command: [
      "bun",
      "-e",
      "const root=process.env.POCKETCODER_INPUT_DIRECTORY;const manifest=await Bun.file(root+'/manifest.json').json();const input=await Bun.file(root+'/'+manifest.objects[0].fileId).text();await Bun.write('/outputs/result.txt',input+'-result');",
    ],
  };
  return {
    manifest: parseWorkloadTemplate(source).manifest,
    image,
    tag,
    remove: () => dockerCommand("image", "rm", "-f", tag),
  };
}
