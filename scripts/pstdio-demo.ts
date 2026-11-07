import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseWorkloadTemplate, sha256Hex } from "@pstdio/pocketcoder-contracts";

const repo = resolve(import.meta.dir, "..");
const output = process.argv[process.argv.indexOf("--output") + 1];
if (!process.argv.includes("--output") || !output) throw new Error("Use --output <template.json>.");
const stage = await mkdtemp(join(tmpdir(), "pocketcoder-file-agent-"));
const imageTag = `pocketcoder-file-agent:${randomUUID()}`;
async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(err);
  return out.trim();
}
try {
  for (const [source, name] of [
    ["packages/supervisor/src/index.ts", "supervisor"],
    ["examples/harnesses/file-agent/adapter.ts", "adapter"],
  ]) {
    const built = await Bun.build({
      entrypoints: [join(repo, source as string)],
      target: "bun",
      outdir: stage,
      naming: `${name}.js`,
    });
    if (!built.success) throw new Error(`Could not build ${name}`);
  }
  const hash = async (name: string) => `sha256:${sha256Hex(await Bun.file(join(stage, name)).bytes())}`;
  const capabilities = [
    "unknown-outcome",
    "request-lookup",
    "deduplicated-accept",
    "targeted-cancel",
    "explicit-publication",
  ];
  const runtime = { digest: await hash("supervisor.js"), protocol: "pocketcoder.workload/v1" };
  const adapter = {
    kind: "service",
    digest: await hash("adapter.js"),
    protocol: "pocketcoder.execution/v1",
    artifact: "/opt/pocketcoder/adapter.js",
    baseUrl: "http://127.0.0.1:3284",
    healthPath: "/status",
    capabilities,
    command: ["bun", "/opt/pocketcoder/adapter.js"],
    environment: [],
  };
  await Bun.write(
    join(stage, "workload.json"),
    JSON.stringify({
      format: "pocketcoder.image/v1",
      codeRoots: ["/opt", "/usr", "/bin", "/sbin", "/lib", "/lib64"],
      runtime: {
        ...runtime,
        artifact: "/opt/pocketcoder/supervisor.js",
        command: [
          "/usr/local/bin/bun",
          "/opt/pocketcoder/supervisor.js",
          "supervise",
          "--launch-input",
          "/run/pocketcoder/input",
        ],
        entrypoint: ["/usr/local/bin/docker-entrypoint.sh"],
      },
      adapters: { main: adapter },
    }),
  );
  await Bun.write(
    join(stage, "Dockerfile"),
    "FROM oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895\nCOPY supervisor.js adapter.js workload.json /opt/pocketcoder/\n",
  );
  await docker("build", "-q", "-t", imageTag, stage);
  const image = `${imageTag}@${await docker("image", "inspect", "--format", "{{.Id}}", imageTag)}`;
  const manifest = parseWorkloadTemplate({
    apiVersion: "pocketcoder.dev/v1",
    kind: "Template",
    metadata: {
      name: "file-agent",
      description:
        "Local reference agent: reads uploaded files and echoes their exact text or digest. No model credentials.",
    },
    spec: {
      version: "1.0.0",
      image,
      runtime,
      profile: "service",
      adapters: { main: { kind: adapter.kind, digest: adapter.digest, protocol: adapter.protocol, service: "agent" } },
      operations: {
        message: {
          adapter: "main",
          inputSchema: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
            additionalProperties: false,
          },
          requiredCapabilities: ["immutable-inputs"],
          outputRoots: [],
        },
      },
      services: {
        agent: {
          baseUrl: adapter.baseUrl,
          healthPath: adapter.healthPath,
          required: true,
          process: { command: adapter.command },
          routes: ["accept", "lookup", "cancel", "ack"].map((action) => ({
            method: "POST",
            path: `/executions/${action}`,
          })),
        },
      },
      previews: {},
      credentialSlots: {},
      resources: { cpu: "0.2", memory: "256Mi" },
      network: { mode: "unrestricted" },
      security: {},
      lifecycle: {
        timeouts: { start: "30s", idle: "600s", maxAge: "600s", disconnectGrace: "30s", terminateGrace: "1s" },
      },
      limits: {
        deadlineSeconds: 600,
        finalizationSeconds: 30,
        inputFileBytes: 1048576,
        stagedInputBytes: 8388608,
        inputFiles: 16,
        inFlightTransfers: 2,
        exportBytes: 4194304,
        exportFiles: 16,
        unreferencedInputRetentionSeconds: 600,
        exportRetentionSeconds: 900,
      },
    },
  }).manifest;
  await mkdir(resolve(output, ".."), { recursive: true });
  await Bun.write(output, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ template: resolve(output), image, imageTag }));
} catch (error) {
  await docker("image", "rm", "-f", imageTag).catch(() => {});
  throw error;
} finally {
  await rm(stage, { recursive: true, force: true });
}
