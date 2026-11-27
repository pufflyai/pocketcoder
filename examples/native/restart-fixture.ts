import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeController } from "./controller";

const binary = process.argv[2];
if (!binary) throw new Error("Usage: restart-fixture.ts <compiled-controller>");
const directory = await mkdtemp(join(tmpdir(), "pocketcoder-native-"));
try {
  const controller = await nativeController(binary, directory);
  try {
    const { size } = await stat(controller.executable);
    assert.ok(size <= 150_000_000);
    assert.deepEqual((await readdir(directory)).sort(), ["pocketcoder", "tools"]);
    assert.deepEqual(await readdir(join(directory, "tools")), ["docker"]);
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
    assert.equal(typeof owner.token, "string");
    assert.equal(JSON.parse(await controller.run(args)).token, null);
    await controller.stop();
    await controller.start();
    const principals = JSON.parse(await controller.run(["principals", "list", "--json"], owner.token));
    assert.ok(principals.items.some((row: { id: string }) => row.id === owner.key.principal_id));
    await controller.stop();
    console.log(JSON.stringify({ binaryBytes: size, starts: controller.measurements }));
  } finally {
    await controller.stop();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
