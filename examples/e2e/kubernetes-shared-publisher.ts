import { strict as assert } from "node:assert";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KubernetesSharedStorage } from "@pstdio/pocketcoder-drivers";
import type { InputProjectionRef, InputStorageDriver } from "@pstdio/pocketcoder-runtime-core";

export async function resumePublisher(shared: KubernetesSharedStorage, canonical: InputStorageDriver) {
  if (!process.env.RESTART_PROJECTION) return;

  const projection: InputProjectionRef = JSON.parse(await readFile(process.env.RESTART_PROJECTION, "utf8"));
  const source: InputStorageDriver = {
    create: canonical.create.bind(canonical),
    verify: canonical.verify.bind(canonical),
    remove: canonical.remove.bind(canonical),
    pruneEmpty: canonical.pruneEmpty.bind(canonical),
    list: canonical.list.bind(canonical),
    read: async (...args) => {
      const stream = await canonical.read(...args);
      if (!process.env.STALL_PUBLICATION) return stream;
      const reader = stream.getReader();
      let first = true;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!first) {
            await new Promise(() => {});
            return;
          }
          first = false;
          const result = await reader.read();
          if (result.done) throw new Error("Crash fixture needs a nonempty input");
          controller.enqueue(result.value);
        },
        async cancel() {
          await reader.cancel();
        },
      });
    },
  };
  await shared.publishInputs(projection, source);
  console.log("publisher restarted and verified original publication");
  process.exit(0);
}

export async function crashAndRestartPublisher(
  entry: string,
  projection: InputProjectionRef,
  shared: KubernetesSharedStorage,
  canonical: InputStorageDriver,
) {
  const reference = projection.objects[0]?.reference;
  assert.ok(reference);
  const restartPath = "/data/private/projection.json";
  await writeFile(restartPath, JSON.stringify(projection), { mode: 0o600 });
  const interrupted = Bun.spawn([process.execPath, entry], {
    env: { ...process.env, RESTART_PROJECTION: restartPath, STALL_PUBLICATION: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const pending = join(
    shared.options.root,
    "inputs",
    projection.manifest.workspaceId,
    "pending",
    projection.manifestId,
    reference.fileId,
  );
  const crashDeadline = Date.now() + 5000;
  while (Date.now() < crashDeadline && !(await stat(pending).catch(() => null))?.size) await Bun.sleep(10);
  const copied = (await stat(pending).catch(() => null))?.size ?? 0;
  interrupted.kill("SIGKILL");
  await interrupted.exited;
  assert.ok(copied > 0, "Publisher must copy actual bytes before SIGKILL");
  assert.equal(interrupted.signalCode, "SIGKILL");
  const child = Bun.spawn([process.execPath, entry], {
    env: { ...process.env, RESTART_PROJECTION: restartPath },
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(await child.exited, 0);
  await shared.publishInputs(projection, canonical);
}
