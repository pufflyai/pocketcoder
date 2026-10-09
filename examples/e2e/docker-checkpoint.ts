import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  OperationResourceSchema,
  PreserveResponseSchema,
  parseTemplateManifest,
  RestoreResponseSchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { buildLocalImage } from "../local/runtime";
import { assertRejectedCheckpoint, cancelRecoverableSource } from "./checkpoint-rejection";
import { assertCheckpointSettlement } from "./checkpoint-settlement";
import { createHarnessWorkspace, type ReadyHarnessWorkspace } from "./contract";
import { messageList, responseText } from "./contract-messages";
import { bestEffort, command, freePort, waitFor } from "./local-process";

const root = resolve(import.meta.dir, "../..");
const directory = await realpath(await mkdtemp(join(tmpdir(), "pocketcoder-checkpoint-")));
const dataDir = join(directory, "pc_data");
const templateDir = join(directory, "templates");
const imageTag = `pocketcoder-checkpoint:${randomUUID()}`;
const operatorPort = freePort();
const agentPort = freePort();
const baseUrl = `http://127.0.0.1:${operatorPort}`;
const cli = ["bun", "--no-env-file", "packages/cli/src/index.ts"];
const bytes = Buffer.from([0, 1, 2, 10, 127, 128, 254, 255]);
const tree = {
  known: bytes.toString("base64"),
  "nested/deep/binary": Buffer.from("edited\u0000checkpoint\nexact bytes\n").toString("base64"),
  "nested/empty": "",
};
let controller: ReturnType<typeof Bun.spawn> | undefined;
let output: Promise<string[]> | undefined;
let source: ReadyHarnessWorkspace | undefined;
let rejectedSource: ReadyHarnessWorkspace | undefined;
let destinationId: string | undefined;
let sourcePreserved = false;

try {
  await command(
    ["bun", "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"],
    { quiet: true },
  );
  const image = await buildLocalImage({ root, imageTag, context: "deploy/image", command });
  const manifest = JSON.parse(await readFile(join(root, "examples/harnesses/echo/template.json"), "utf8"));
  manifest.spec.image = image.image;
  manifest.spec.persistence = { mounts: [{ name: "work", target: "/work", maxBytes: 1024 * 1024, maxFiles: 100 }] };
  manifest.spec.setup = [
    {
      name: "verify-restored-tree",
      runOn: ["restore"],
      timeoutSeconds: 5,
      command: [
        "bun",
        "-e",
        `for (const [path, bytes] of Object.entries(${JSON.stringify(tree)})) if (Buffer.from(await Bun.file('/work/' + path).arrayBuffer()).toString('base64') !== bytes) throw new Error('Restore setup ran before exact tree publication');`,
      ],
    },
  ];
  const template = parseTemplateManifest(manifest);
  await mkdir(templateDir);
  await writeFile(join(templateDir, "echo.json"), JSON.stringify(template.manifest));
  const processHandle = Bun.spawn([...cli, "serve", "--dir", dataDir], {
    cwd: root,
    env: {
      ...process.env,
      POCKETCODER_DIR: dataDir,
      POCKETCODER_TEMPLATE_DIR: undefined,
      POCKETCODER_HTTP: `127.0.0.1:${operatorPort}`,
      POCKETCODER_AGENT_HTTP: `0.0.0.0:${agentPort}`,
      POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${agentPort}`,
      POCKETCODER_INPUT_DIR: join(directory, "inputs"),
      POCKETCODER_STORAGE_BACKEND: "filesystem",
      POCKETCODER_WORKSPACE_DATA_DIR: join(directory, "live"),
      POCKETCODER_CHECKPOINT_DIR: join(directory, "checkpoints"),
      POCKETCODER_SECRET_PROVIDER: "disabled",
      POCKETCODER_WARM_POOLS: "[]",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  controller = processHandle;
  output = Promise.all([new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text()]);
  await waitFor(
    async () => {
      if (controller?.exitCode !== null) throw new Error(`Controller exited: ${(await output)?.join("\n")}`);
      return fetch(`${baseUrl}/readyz`)
        .then((response) => response.ok)
        .catch(() => false);
    },
    30_000,
    "controller",
  );
  const owner = JSON.parse(
    (
      await command(
        [
          ...cli,
          "superuser",
          "create",
          "--dir",
          dataDir,
          "--automation",
          "--expires",
          new Date(Date.now() + 600_000).toISOString(),
          "--request-id",
          randomUUID(),
          "--json",
        ],
        { quiet: true },
      )
    ).stdout,
  );
  const env = { POCKETCODER_URL: baseUrl, POCKETCODER_KEY: owner.token };
  await command([...cli, "templates", "import", templateDir], { env, quiet: true });
  source = await createHarnessWorkspace({ baseUrl, key: owner.token, template: "echo-harness" });
  const sourceName = `pocketcoder-ws-${source.workspaceId}`;
  const eventsSince = String(Math.floor(Date.now() / 1000));
  const inspect = JSON.parse((await command(["docker", "inspect", sourceName], { quiet: true })).stdout)[0];
  if (inspect.HostConfig.Tmpfs?.["/work"] !== "rw,noexec,nosuid,nodev,size=1048576,uid=10001,gid=10001,mode=0700")
    throw new Error("Persistence mount is not bounded disposable Docker storage");
  await command(
    [
      "docker",
      "exec",
      sourceName,
      "bun",
      "-e",
      `const tree = ${JSON.stringify(tree)}; await import('node:fs/promises').then(fs => fs.mkdir('/work/nested/deep', {recursive:true})); await Bun.write('/work/known', 'initial'); for (const [path, bytes] of Object.entries(tree)) await Bun.write('/work/' + path, Buffer.from(bytes, 'base64'));`,
    ],
    { quiet: true },
  );
  const preserved = PreserveResponseSchema.parse(
    JSON.parse(
      (await command([...cli, "workspaces", "preserve", "--id", source.workspaceId], { env, quiet: true })).stdout,
    ),
  );
  await waitFor(
    async () => {
      const operation = OperationResourceSchema.parse(
        await (await source?.request(`/v1/operations/${preserved.operation.id}`))?.json(),
      );
      if (operation.state === "failed") throw new Error(`Preserve failed: ${operation.reason_code}`);
      return operation.state === "succeeded";
    },
    30_000,
    "durable preserve",
  );
  if ((await command(["docker", "ps", "-aq", "--filter", `name=^/${sourceName}$`], { quiet: true })).stdout)
    throw new Error("Preserved source container survived");
  sourcePreserved = true;
  const stopEvents = await command(
    [
      "docker",
      "events",
      "--since",
      eventsSince,
      "--until",
      new Date().toISOString(),
      "--filter",
      `label=pocketcoder.workspace=${source.workspaceId}`,
      "--filter",
      "event=stop",
      "--format",
      "{{json .}}",
    ],
    { quiet: true },
  );
  const stopped = stopEvents.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((value) => JSON.parse(value));
  if (stopped.length !== 1) throw new Error("Source has no exact Docker stop evidence");
  const sourceStoppedAt = Math.floor(stopped[0].timeNano / 1_000_000);
  const verified = await source.request(`/v1/checkpoints/${preserved.checkpoint.id}/verify`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
  });
  if (!verified.ok) throw new Error(`Durable archive verification refused: ${await verified.text()}`);
  const restored = await source.request(`/v1/checkpoints/${preserved.checkpoint.id}/restore`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: JSON.stringify({ external_id: randomUUID() }),
  });
  if (!restored.ok) throw new Error(`Restore refused: ${await restored.text()}`);
  const result = RestoreResponseSchema.parse(await restored.json());
  destinationId = result.workspace.id;
  if (destinationId === source.workspaceId) throw new Error("Restore reused source identity");
  await waitFor(
    async () => {
      const operation = OperationResourceSchema.parse(
        await (await source?.request(`/v1/operations/${result.operation.id}`))?.json(),
      );
      const workspace = WorkspaceResourceSchema.parse(
        await (await source?.request(`/v1/workspaces/${destinationId}`))?.json(),
      );
      if (workspace.state === "failed") throw new Error(`Restore failed: ${workspace.reason_code}`);
      if (operation.state === "succeeded" && workspace.state !== "ready")
        throw new Error("Restore operation succeeded before readiness");
      return workspace.state === "ready";
    },
    30_000,
    "verified destination readiness",
  );
  const read = await command(
    [
      "docker",
      "exec",
      `pocketcoder-ws-${destinationId}`,
      "bun",
      "-e",
      `const result = {}; for (const path of Object.keys(${JSON.stringify(tree)})) result[path] = Buffer.from(await Bun.file('/work/' + path).arrayBuffer()).toString('base64'); console.log(JSON.stringify({bytes:result,paths:(await import('node:fs/promises').then(fs => fs.readdir('/work', {recursive:true}))).sort()}));`,
    ],
    { quiet: true },
  );
  const restoredTree = JSON.parse(read.stdout);
  if (JSON.stringify(restoredTree.bytes) !== JSON.stringify(tree)) throw new Error("Restored tree bytes differ");
  if (
    JSON.stringify(restoredTree.paths) !==
    JSON.stringify(["known", "nested", "nested/deep", "nested/deep/binary", "nested/empty"])
  )
    throw new Error("Restored directory tree differs");
  const prompt = `restored ${randomUUID()}`;
  const sent = await source.request(`/v1/workspaces/${destinationId}/agent/message`, {
    method: "POST",
    body: JSON.stringify({ type: "user", content: prompt }),
  });
  if (!sent.ok) throw new Error(`Harness message refused: ${await sent.text()}`);
  await waitFor(
    async () => {
      const response = await source?.request(`/v1/workspaces/${destinationId}/agent/messages`);
      return responseText(messageList(await response?.json()), 0) === `echo: ${prompt}`;
    },
    30_000,
    "restored harness response",
  );
  rejectedSource = await createHarnessWorkspace({ baseUrl, key: owner.token, template: "echo-harness" });
  const rejectedCapture = await assertRejectedCheckpoint(rejectedSource);
  await cancelRecoverableSource(rejectedSource);
  await source.request(`/v1/workspaces/${destinationId}/cancel`, { method: "POST" });
  controller.kill("SIGTERM");
  await controller.exited;
  const controllerLogs = (await output)?.join("\n") ?? "";
  if (/DrizzleQueryError|protocol error: internal error/.test(controllerLogs))
    throw new Error("Normal teardown left controller queries running after shutdown");
  const settlement = await assertCheckpointSettlement({
    dataDir,
    checkpointDir: join(directory, "checkpoints"),
    sourceId: source.workspaceId,
    destinationId: result.workspace.id,
    checkpointId: preserved.checkpoint.id,
    restoreOperationId: result.operation.id,
    sourceStoppedAt,
    rejectedCapture,
  });
  console.log(
    JSON.stringify(
      {
        result: "passed",
        sourceId: source.workspaceId,
        destinationId,
        exactBytes: Object.values(tree).reduce((total, value) => total + Buffer.from(value, "base64").length, 0),
        image: image.image,
        settlement,
        rejectedCapture,
      },
      null,
      2,
    ),
  );
} catch (error) {
  for (const id of [source?.workspaceId, destinationId, rejectedSource?.workspaceId]) {
    if (id) {
      const logs = await command(["docker", "logs", `pocketcoder-ws-${id}`], { quiet: true }).catch(() => null);
      if (logs) console.log(`workspace ${id}:\n${logs.stdout}\n${logs.stderr}`);
      const files = await command(
        [
          "docker",
          "exec",
          `pocketcoder-ws-${id}`,
          "bun",
          "-e",
          "const fs = await import('node:fs/promises'); console.log(JSON.stringify({work:await fs.readdir('/work',{recursive:true}),scratch:(await fs.readdir('/tmp')).filter(path => path.startsWith('pocketcoder-transfer-'))}));",
        ],
        { quiet: true },
      ).catch(() => null);
      if (files) console.log(`workspace filesystem ${id}: ${files.stdout}`);
      const state = await source
        ?.request(`/v1/workspaces/${id}`)
        .then((response) => response.text())
        .catch(() => "");
      const runtimeLogs = await source
        ?.request(`/v1/workspaces/${id}/logs`)
        .then((response) => response.text())
        .catch(() => "");
      console.log(`workspace state ${id}: ${state}\nruntime logs: ${runtimeLogs}`);
    }
  }
  throw error;
} finally {
  if (destinationId)
    await source?.request(`/v1/workspaces/${destinationId}/cancel`, { method: "POST" }).catch(() => {});
  if (!sourcePreserved) await source?.cancel().catch(() => {});
  await rejectedSource?.cancel().catch(() => {});
  if (controller) {
    controller.kill("SIGTERM");
    await controller.exited;
    console.log((await output)?.join("\n"));
  }
  for (const id of [source?.workspaceId, destinationId, rejectedSource?.workspaceId]) {
    if (id) await bestEffort(["docker", "rm", "--force", `pocketcoder-ws-${id}`]);
  }
  await bestEffort(["docker", "image", "rm", "--force", imageTag]);
  await rm(directory, { recursive: true, force: true });
}
