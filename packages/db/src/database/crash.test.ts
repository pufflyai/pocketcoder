import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "../store";
import { lockDataFolder } from "./data-folder";

const fixture = join(import.meta.dir, "crash-fixture.ts");

async function acknowledgedLines(child: ReturnType<typeof Bun.spawn>, count: number) {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let output = "";
  try {
    while (output.split("\n").length - 1 < count) {
      const part = await reader.read();
      if (part.done) throw new Error(`child exited early: ${output}`);
      output += new TextDecoder().decode(part.value);
    }
    return output.split("\n").slice(0, -1);
  } finally {
    reader.releaseLock();
  }
}

test("SIGKILL releases a lock even when diagnostic PID metadata is stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pc-lock-"));
  await writeFile(join(dir, "LOCK"), `pid=${process.pid}\n`);
  const child = Bun.spawn([process.execPath, fixture, "lock", dir], { stdout: "pipe", stderr: "inherit" });
  try {
    await acknowledgedLines(child, 1);
    expect(() => lockDataFolder(dir)).toThrow("data folder is in use");
    await symlink(dir, join(dir, "alias"));
    expect(() => lockDataFolder(join(dir, "alias"))).toThrow("data folder is in use");
    child.kill("SIGKILL");
    await child.exited;
    const lock = lockDataFolder(dir);
    lock.close();
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(dir, { recursive: true, force: true });
  }
});

test.each(["source", "compiled", "bundle"] as const)(
  "acknowledged writes survive SIGKILL (%s), within the memory budget",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "pc-crash-"));
    const binary = mode === "bundle" ? join(dir, "bundle", "crash-fixture.js") : join(dir, "database-fixture");
    if (mode !== "source") {
      const build = Bun.spawn(
        [
          process.execPath,
          "build",
          fixture,
          ...(mode === "compiled"
            ? ["--compile", "--outfile", binary]
            : ["--target", "bun", "--outdir", join(dir, "bundle")]),
        ],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      expect(await build.exited).toBe(0);
    }
    const invocation = mode === "compiled" ? [binary] : [process.execPath, mode === "bundle" ? binary : fixture];
    const data = join(dir, "data");
    const child = Bun.spawn([...invocation, "write", data], { cwd: dir, stdout: "pipe", stderr: "inherit" });
    try {
      const lines = await acknowledgedLines(child, 33);
      child.kill("SIGKILL");
      await child.exited;
      const start = JSON.parse(lines[0] ?? "");
      expect(start.peakKiB * 1024).toBeLessThan(512 * 1024 ** 2);
      const acknowledged = lines.slice(1).map((line) => JSON.parse(line));
      const reopened = Bun.spawn([...invocation, "inspect", data], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(reopened.stdout).text();
      const errors = await new Response(reopened.stderr).text();
      expect(errors).toBe("");
      expect(await reopened.exited).toBe(0);
      const restored = JSON.parse(output);
      for (const row of acknowledged) expect(restored.principals).toContainEqual(expect.objectContaining(row));
      expect(
        restored.migrations.every(
          (row: { appliedAt: string | null; drifted: boolean }) => row.appliedAt && !row.drifted,
        ),
      ).toBe(true);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);

test("an interrupted staged seed is discarded, while incomplete published data is preserved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pc-seed-"));
  try {
    await mkdir(join(dir, ".db-staging"));
    await writeFile(join(dir, ".db-staging", "partial"), "interrupted");
    const store = await PGliteStore.create(dir);
    await store.close();
    await rm(join(dir, "db"), { recursive: true });
    await mkdir(join(dir, "db"));
    await writeFile(join(dir, "db", "partial"), "existing data");
    await expect(PGliteStore.create(dir)).rejects.toThrow("incomplete database directory");
    expect(await Bun.file(join(dir, "db", "partial")).text()).toBe("existing data");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
