import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digestOf } from "@pstdio/pocketcoder-contracts";

export const serviceProbeImage = "oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";
export async function dockerCommand(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(`docker ${args[0]}: ${err.slice(-3000)}`);
  return out.trim();
}

const adapter = `
const records = new Map();
Bun.serve({hostname:'127.0.0.1',port:3284,async fetch(req) {
 const action=new URL(req.url).pathname;
 if(action==='/status')return Response.json({status:'stable'});
 const body=await req.json();const acceptance=body.acceptance;
 const execution=acceptance?.execution??body.execution;const key=execution.requestId;
 if(action==='/executions/accept'&&!records.has(key)) {
  const manifest=await Bun.file(body.inputDirectory+'/manifest.json').json();
  const path=body.inputDirectory+'/'+manifest.objects[0].fileId;
  const content=await Bun.file(path).text();let immutable=false;
  try{await Bun.write(path,'tampered')}catch{immutable=true}
  records.set(key,{execution,fingerprint:acceptance.fingerprint,phase:'terminal',outcome:{content,immutable}});
 }
 if(action==='/executions/cancel'&&!records.has(key))records.set(key,{execution,fingerprint:body.fingerprint,phase:'canceled',outcome:null});
 if(action==='/executions/ack')return Response.json({ok:true});
 return Response.json(records.get(key)??{execution,phase:'absent'});
}});
`;

export async function serviceImageFixture(directory: string) {
  await mkdir(directory, { recursive: true });
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../../supervisor/src/index.ts")],
    outdir: directory,
    target: "bun",
  });
  if (!build.success) throw new Error("Supervisor build failed");
  await Bun.write(join(directory, "adapter.js"), adapter);
  const hash = async (name: string) =>
    `sha256:${new Bun.CryptoHasher("sha256").update(await Bun.file(join(directory, name)).bytes()).digest("hex")}`;
  await Bun.write(join(directory, "supervisor.js"), Bun.file(join(directory, "index.js")));
  const runtime = { digest: await hash("supervisor.js"), protocol: "pocketcoder.workload/v1" as const };
  const capabilities = [
    "unknown-outcome",
    "request-lookup",
    "deduplicated-accept",
    "targeted-cancel",
    "explicit-publication",
  ];
  const main = {
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
    join(directory, "workload.json"),
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
      adapters: { main },
    }),
  );
  await Bun.write(
    join(directory, "Dockerfile"),
    `FROM ${serviceProbeImage}\nCOPY supervisor.js adapter.js workload.json /opt/pocketcoder/\nRUN printf '#!/bin/sh\\nexec bun /opt/pocketcoder/index.js "$@"\\n' > /usr/local/bin/pocketcoder-supervisor && chmod 0555 /usr/local/bin/pocketcoder-supervisor\n`,
  );
  const tag = `pocketcoder-service-proof:${randomUUID()}`;
  await dockerCommand("build", "-q", "-t", tag, directory);
  const image = `${tag}@${await dockerCommand("image", "inspect", "--format", "{{.Id}}", tag)}`;
  const manifest = {
    apiVersion: "pocketcoder.dev/v1",
    kind: "Template",
    metadata: { name: "service-file-proof" },
    spec: {
      version: "1.0.0",
      image,
      runtime,
      profile: "service",
      adapters: { main: { kind: main.kind, digest: main.digest, protocol: main.protocol, service: "agent" } },
      operations: {
        message: {
          adapter: "main",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          requiredCapabilities: ["immutable-inputs"],
          outputRoots: [],
        },
      },
      services: {
        agent: {
          baseUrl: "http://127.0.0.1:3284",
          healthPath: "/status",
          required: true,
          process: { command: ["bun", "/opt/pocketcoder/adapter.js"] },
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
      limits: {
        deadlineSeconds: 600,
        finalizationSeconds: 30,
        inputFileBytes: 1048576,
        stagedInputBytes: 8388608,
        inputFiles: 16,
        inFlightTransfers: 2,
        exportBytes: 1048576,
        exportFiles: 16,
        unreferencedInputRetentionSeconds: 600,
        exportRetentionSeconds: 600,
      },
    },
  };
  return { manifest, tag, image, digest: digestOf(manifest), remove: () => dockerCommand("image", "rm", "-f", tag) };
}
