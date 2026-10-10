import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = join(import.meta.dir, "memory-fixture.ts");

async function run(...args: string[]) {
  // Linux exec keeps the parent's RSS peak. Fork from a small shell first.
  const child = Bun.spawn(["sh", "-c", '"$@"', "pc-backup-memory", process.execPath, fixture, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(errors).toBe("");
  expect(code).toBe(0);
  return output ? JSON.parse(output) : undefined;
}

test("backup and verify stream the database instead of buffering it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pc-backup-memory-"));
  try {
    const output = join(dir, "backup.tar");
    await run("fill", join(dir, "data"), output);
    const backup = await run("backup", join(dir, "data"), output);
    expect(backup.bytes).toBeGreaterThan(128 * 1024 ** 2);
    expect(backup.peakKiB * 1024).toBeLessThan(512 * 1024 ** 2);
    // Copying adds a bounded buffer, not the archive size, to the opened controller.
    expect((backup.peakKiB - backup.openedKiB) * 1024).toBeLessThan(64 * 1024 ** 2);
    expect((await run("verify", join(dir, "data"), output)).peakKiB * 1024).toBeLessThan(512 * 1024 ** 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
