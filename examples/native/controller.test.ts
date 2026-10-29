import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command } from "../e2e/local-process";
import { nativeRecord } from "./artifact";
import { nativeController } from "./controller";
import { checkInstalledNative } from "./installed";

test("one executable starts and restarts outside the checkout without Bun or adjacent assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-native-"));
  const root = resolve(import.meta.dir, "../..");
  await command([process.execPath, "run", "build:native"], { quiet: true });
  const controller = await nativeController(join(root, "out/native/pocketcoder"), directory);
  try {
    expect((await stat(controller.executable)).size).toBeLessThanOrEqual(90_000_000);
    expect((await readdir(directory)).sort()).toEqual(["pocketcoder", "tools"]);
    expect(await readdir(join(directory, "tools"))).toEqual(["docker"]);
    await controller.start();
    const args = [
      "superuser",
      "create",
      "--automation",
      "--expires",
      new Date(Date.now() + 60_000).toISOString(),
      "--request-id",
      randomUUID(),
      "--json",
    ];
    const owner = JSON.parse(await controller.run(args));
    expect(owner.token).toBeString();
    expect(JSON.parse(await controller.run(args)).token).toBeNull();
    await controller.stop();
    await controller.start();
    const principals = JSON.parse(await controller.run(["principals", "list", "--json"], owner.token));
    expect(principals.items.some((row: { id: string }) => row.id === owner.key.principal_id)).toBe(true);
    await controller.stop();
    console.log(
      JSON.stringify({ binaryBytes: (await stat(controller.executable)).size, starts: controller.measurements }),
    );
  } finally {
    await controller.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("an installed binary restores its backup and matches its recorded embedded format", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-native-artifact-"));
  const root = resolve(import.meta.dir, "../..");
  const commit = "a".repeat(40);
  try {
    await command([process.execPath, "run", "build:native"], { quiet: true });
    const binary = join(root, "out/native/pocketcoder");
    const record = await nativeRecord(binary, commit);
    await Bun.write(join(directory, "pocketcoder"), Bun.file(binary));
    await Bun.write(join(directory, "native.json"), JSON.stringify(record));
    const result = await checkInstalledNative(directory, commit);
    expect(result.result).toBe("passed");
    expect(result.bunInControllerPath).toBe(false);
    expect(result.starts).toHaveLength(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
