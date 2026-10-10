import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command } from "../e2e/local-process";
import { verifyNativeArtifact } from "./artifact";
import { nativeController } from "./controller";

export async function checkInstalledNative(artifact: string, commit: string) {
  const record = await verifyNativeArtifact(artifact, commit);
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-installed-"));
  const controller = await nativeController(join(artifact, "pocketcoder"), directory);
  try {
    if ((await controller.run(["--version"])).trim() !== record.version) throw new Error("Binary version differs");
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
    if (!owner.token || JSON.parse(await controller.run(ownerArgs)).token !== null)
      throw new Error("Owner key was not returned exactly once");
    const keys = ["auth-pepper", "event-signing-key", "secret-key"];
    const originalKeys = await Promise.all(
      keys.map(async (name) => ({ name, bytes: await readFile(join(directory, "pc_data/keys", name)) })),
    );
    await controller.stop();
    await controller.start();
    await controller.run(["principals", "list", "--json"], owner.token);
    await mkdir(join(directory, "backups"), { mode: 0o700 });
    const archive = join(directory, "backups/controller.tar");
    const backup = JSON.parse(await controller.run(["backup", "create", "--out", archive]));
    const verified = JSON.parse(await controller.run(["backup", "verify", archive]));
    if (!verified.ok || verified.snapshot_id !== backup.snapshot_id) throw new Error("Backup verification differs");
    // Check the format emitted by the executable, rather than trusting its adjacent record.
    const manifest = JSON.parse((await command(["tar", "-xOf", archive, "manifest.json"], { quiet: true })).stdout);
    if (
      manifest.engine.pglite !== record.database.pglite ||
      manifest.engine.postgres !== record.database.postgres ||
      JSON.stringify(manifest.database.migrations) !== JSON.stringify(record.database.migrations)
    )
      throw new Error("Embedded database format differs");
    await controller.stop();
    const restored = join(directory, "restored");
    const recovery = JSON.parse(await controller.run(["backup", "restore", archive, "--dir", restored]));
    controller.useDataFolder(restored, join(directory, "checkpoints"));
    await controller.start("recovery");
    const completed = JSON.parse(await controller.run(["recovery", "complete"]));
    if (!completed.complete || completed.recovery_id !== recovery.recovery_id) throw new Error("Recovery differs");
    await controller.stop();
    await controller.start();
    const principals = JSON.parse(await controller.run(["principals", "list", "--json"], owner.token));
    if (!principals.items.some((row: { id: string }) => row.id === owner.key.principal_id))
      throw new Error("Restored owner is missing");
    for (const { name, bytes } of originalKeys) {
      if (!(await readFile(join(restored, "keys", name))).equals(bytes))
        throw new Error("Restored controller identity differs");
    }
    await controller.stop();
    return {
      result: "passed",
      ...record,
      starts: controller.measurements,
      backupFormat: manifest.format,
      bunInControllerPath: false,
    };
  } finally {
    await controller.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [artifact, commit] = process.argv.slice(2);
  if (!artifact || !commit) throw new Error("Usage: installed.ts <artifact-directory> <commit>");
  console.log(JSON.stringify(await checkInstalledNative(resolve(artifact), commit), null, 2));
}
