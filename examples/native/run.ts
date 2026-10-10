import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  OperationResourceSchema,
  PreserveResponseSchema,
  RestoreResponseSchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { bestEffort, command, flag, waitFor } from "../e2e/local-process";
import { buildLocalImage } from "../local/runtime";
import { nativeController } from "./controller";
import { nativeTemplate } from "./template";

const root = resolve(import.meta.dir, "../..");
const directory = await realpath(await mkdtemp(join(tmpdir(), "pocketcoder-native-flow-")));
const imageTag = `pocketcoder-native:${randomUUID()}`;
const binary = resolve(flag("--binary") ?? join(root, "out/native/pocketcoder"));
const tree = {
  known: Buffer.from([0, 1, 2, 10, 127, 128, 254, 255]).toString("base64"),
  "nested/deep/binary": Buffer.from("edited\u0000checkpoint\nexact bytes\n").toString("base64"),
  "nested/empty": "",
};
const workspaceIds: string[] = [];
let controller: Awaited<ReturnType<typeof nativeController>> | undefined;
let ownerToken: string | undefined;

async function request(path: string) {
  const response = await fetch(`${controller?.baseUrl}${path}`, { headers: { authorization: `Bearer ${ownerToken}` } });
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
  return response.json();
}

async function operation(id: string) {
  await waitFor(
    async () => {
      const current = OperationResourceSchema.parse(await request(`/v1/operations/${id}`));
      if (current.state === "failed") throw new Error(`Operation failed: ${current.reason_code}`);
      return current.state === "succeeded";
    },
    30_000,
    "native checkpoint operation",
  );
}

async function identity(dataDir = "pc_data") {
  return Promise.all(
    ["auth-pepper", "event-signing-key", "secret-key"].map(async (name) =>
      createHash("sha256")
        .update(await readFile(join(directory, dataDir, "keys", name)))
        .digest("hex"),
    ),
  );
}

try {
  if (!flag("--binary")) await command([process.execPath, "run", "build:native"], { quiet: true });
  const binaryBytes = (await stat(binary)).size;
  if (binaryBytes > 90_000_000) throw new Error(`Executable exceeded 90 MB: ${binaryBytes} bytes`);
  await command(
    [process.execPath, "build", "packages/supervisor/src/index.ts", "--target", "bun", "--outdir", "deploy/image/dist"],
    { quiet: true },
  );
  const image = await buildLocalImage({ root, imageTag, context: "deploy/image", command });
  const template = await nativeTemplate(image.image);
  const templates = join(directory, "templates");
  await mkdir(templates);
  await writeFile(join(templates, "echo.json"), JSON.stringify(template.manifest));
  controller = await nativeController(binary, directory, true);
  await controller.start();
  const ownerArgs = [
    "superuser",
    "create",
    "--automation",
    "--expires",
    new Date(Date.now() + 600_000).toISOString(),
    "--request-id",
    randomUUID(),
    "--json",
  ];
  const owner = JSON.parse(await controller.run(ownerArgs));
  ownerToken = owner.token;
  if (!ownerToken || JSON.parse(await controller.run(ownerArgs)).token !== null)
    throw new Error("Owner key was not returned exactly once.");
  await controller.run(["templates", "import", templates], ownerToken);
  const before = await identity();
  const source = WorkspaceResourceSchema.parse(
    JSON.parse(
      await controller.run(["workspaces", "create", "--template", "echo-harness", "--wait", "--json"], ownerToken),
    ),
  );
  workspaceIds.push(source.id);
  const prompt = `native source ${randomUUID()}`;
  const reply = await controller.run(
    ["workspaces", "chat", "--id", source.id, "--message", prompt, "--response-timeout-seconds", "30", "--json"],
    ownerToken,
  );
  if (!reply.includes(`echo: ${prompt}`)) throw new Error("Native source did not answer its message.");
  const container = `pocketcoder-ws-${source.id}`;
  const inspected = JSON.parse((await command(["docker", "inspect", container], { quiet: true })).stdout)[0];
  if (
    inspected.Mounts.some(
      (mount: { Source: string; Destination: string }) =>
        mount.Source.startsWith(join(directory, "pc_data")) || mount.Destination.includes("docker.sock"),
    )
  )
    throw new Error("Controller data or Docker socket reached the workspace.");
  if (JSON.stringify(inspected.Config.Env).includes(ownerToken)) throw new Error("Owner key reached the workspace.");
  if (inspected.HostConfig.Tmpfs?.["/work"] !== "rw,noexec,nosuid,nodev,size=1048576,uid=10001,gid=10001,mode=0700")
    throw new Error("Workspace storage is not bounded.");
  await command(
    [
      "docker",
      "exec",
      container,
      "bun",
      "-e",
      `await import('node:fs/promises').then(fs => fs.mkdir('/work/nested/deep', {recursive:true})); for (const [path, bytes] of Object.entries(${JSON.stringify(tree)})) await Bun.write('/work/' + path, Buffer.from(bytes, 'base64'));`,
    ],
    { quiet: true },
  );
  const preserved = PreserveResponseSchema.parse(
    JSON.parse(await controller.run(["workspaces", "preserve", "--id", source.id], ownerToken)),
  );
  await operation(preserved.operation.id);
  if ((await command(["docker", "ps", "-aq", "--filter", `name=^/${container}$`], { quiet: true })).stdout)
    throw new Error("Preserved source container survived.");
  await controller.stop();
  await controller.start();
  if (JSON.stringify(before) !== JSON.stringify(await identity()))
    throw new Error("Controller identity changed after preserve.");
  await controller.run(["checkpoints", "verify", "--id", preserved.checkpoint.id], ownerToken);
  // The controller's peak memory, checked when it stops, includes this live backup.
  const backupPath = join(directory, "backups", "controller.tar");
  await mkdir(join(directory, "backups"), { mode: 0o700 });
  const backup = JSON.parse(await controller.run(["backup", "create", "--out", backupPath]));
  const verified = JSON.parse(await controller.run(["backup", "verify", backupPath]));
  if (backup.checkpoints !== 1 || verified.snapshot_id !== backup.snapshot_id || verified.checkpoints !== 1)
    throw new Error("Controller backup did not capture its checkpoint archive.");
  // A key revoked after the backup must stay revoked on the restored controller.
  const late = JSON.parse(await controller.run(ownerArgs.map((arg, index) => (index === 6 ? randomUUID() : arg))));
  const revoked = await fetch(`${controller.baseUrl}/v1/principals/${late.key.principal_id}/keys/${late.key.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  if (!revoked.ok) throw new Error("Owner key revocation failed.");
  await controller.stop();
  const recovery = JSON.parse(
    await controller.run([
      "backup",
      "restore",
      backupPath,
      "--dir",
      join(directory, "pc_restored"),
      "--checkpoint-dir",
      join(directory, "checkpoints-restored"),
    ]),
  );
  controller.useDataFolder(join(directory, "pc_restored"), join(directory, "checkpoints-restored"));
  await controller.start("recovery");
  if ((await fetch(`${controller.baseUrl}/livez`).catch(() => null))?.ok)
    throw new Error("A controller in recovery opened its operator listener.");
  const completed = JSON.parse(await controller.run(["recovery", "complete"]));
  if (!completed.complete || completed.recovery_id !== recovery.recovery_id)
    throw new Error("Recovery did not complete.");
  await controller.stop();
  await controller.start();
  if (JSON.stringify(before) !== JSON.stringify(await identity("pc_restored")))
    throw new Error("Restored controller identity differs from the original.");
  const rejected = await fetch(`${controller.baseUrl}/v1/templates`, {
    headers: { authorization: `Bearer ${late.token}` },
  });
  if (rejected.status !== 401) throw new Error("A key revoked after the backup came back.");
  await controller.run(["checkpoints", "verify", "--id", preserved.checkpoint.id], ownerToken);
  const restored = RestoreResponseSchema.parse(
    JSON.parse(
      await controller.run(
        ["workspaces", "restore", "--checkpoint", preserved.checkpoint.id, "--external-id", randomUUID()],
        ownerToken,
      ),
    ),
  );
  workspaceIds.push(restored.workspace.id);
  if (restored.workspace.id === source.id) throw new Error("Restore reused the original workspace identity.");
  await operation(restored.operation.id);
  const destination = WorkspaceResourceSchema.parse(await request(`/v1/workspaces/${restored.workspace.id}`));
  if (destination.state !== "ready") throw new Error("Restore succeeded before readiness.");
  const exact = await command(
    [
      "docker",
      "exec",
      `pocketcoder-ws-${destination.id}`,
      "bun",
      "-e",
      `for (const [path, bytes] of Object.entries(${JSON.stringify(tree)})) if (Buffer.from(await Bun.file('/work/' + path).arrayBuffer()).toString('base64') !== bytes) throw new Error('Restored bytes differ: ' + path); const paths = (await import('node:fs/promises').then(fs => fs.readdir('/work', {recursive:true}))).sort(); if (JSON.stringify(paths) !== JSON.stringify(['known','nested','nested/deep','nested/deep/binary','nested/empty'])) throw new Error('Restored tree differs'); console.log(JSON.stringify(paths));`,
    ],
    { quiet: true },
  );
  const resumedPrompt = `native resumed ${randomUUID()}`;
  const resumedReply = await controller.run(
    [
      "workspaces",
      "chat",
      "--id",
      destination.id,
      "--message",
      resumedPrompt,
      "--response-timeout-seconds",
      "30",
      "--json",
    ],
    ownerToken,
  );
  if (!resumedReply.includes(`echo: ${resumedPrompt}`)) throw new Error("Restored native workspace did not answer.");
  await controller.run(["workspaces", "cancel", "--id", destination.id], ownerToken);
  await waitFor(
    async () => WorkspaceResourceSchema.parse(await request(`/v1/workspaces/${destination.id}`)).state === "canceled",
    30_000,
    "native workspace cleanup",
  );
  await controller.stop();
  const exported = flag("--export-fixture");
  if (exported) {
    await mkdir(join(exported, "templates"), { recursive: true });
    await writeFile(join(exported, "templates/echo.json"), `${JSON.stringify(template.manifest, null, 2)}\n`);
    await command(["docker", "save", "--output", join(exported, "echo-image.tar"), imageTag], { quiet: true });
  }
  console.log(
    JSON.stringify(
      {
        result: "passed",
        platform: process.platform,
        arch: process.arch,
        binaryBytes,
        starts: controller.measurements,
        sourceId: source.id,
        destinationId: destination.id,
        checkpointId: preserved.checkpoint.id,
        backup: {
          bytes: backup.bytes,
          digest: backup.digest,
          position: backup.position,
          checkpoints: backup.checkpoints,
        },
        recovery: { recoveryId: recovery.recovery_id, events: completed.events, fenced: completed.workspaces },
        exactTree: JSON.parse(exact.stdout),
        exactBytes: Object.values(tree).reduce((total, value) => total + Buffer.from(value, "base64").length, 0),
        image: image.image,
        bunInControllerPath: false,
      },
      null,
      2,
    ),
  );
} finally {
  for (const id of workspaceIds)
    await controller?.run(["workspaces", "cancel", "--id", id], ownerToken).catch(() => {});
  await controller?.stop();
  for (const id of workspaceIds) await bestEffort(["docker", "rm", "-f", `pocketcoder-ws-${id}`]);
  await bestEffort(["docker", "image", "rm", "--force", imageTag]);
  await rm(directory, { recursive: true, force: true });
}
