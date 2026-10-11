import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSeed } from "./data-folder";

test("seed sync makes every nested seed directory and file private", async () => {
  const seed = await mkdtemp(join(tmpdir(), "pc-seed-sync-"));
  try {
    await mkdir(join(seed, "base", "1"), { recursive: true, mode: 0o755 });
    await writeFile(join(seed, "PG_VERSION"), "18\n", { mode: 0o644 });
    await writeFile(join(seed, "base", "1", "1259"), "catalog", { mode: 0o644 });
    await syncSeed(seed);
    for (const directory of [seed, join(seed, "base"), join(seed, "base", "1")])
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const file of [join(seed, "PG_VERSION"), join(seed, "base", "1", "1259")])
      expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(seed, { recursive: true, force: true });
  }
});

test("a refused seed link stops all seed sync work before the failure returns", async () => {
  const seed = await mkdtemp(join(tmpdir(), "pc-seed-link-"));
  try {
    const files = Array.from({ length: 500 }, (_, index) => join(seed, `file-${index}`));
    for (const file of files) await writeFile(file, "x", { mode: 0o644 });
    await symlink(files[0] ?? "", join(seed, "link"));
    await expect(syncSeed(seed)).rejects.toThrow();
    const privateFiles = async () =>
      (await Promise.all(files.map((file) => stat(file)))).filter((s) => (s.mode & 0o777) === 0o600).length;
    const settled = await privateFiles();
    await Bun.sleep(100);
    expect(await privateFiles()).toBe(settled);
  } finally {
    await rm(seed, { recursive: true, force: true });
  }
});

// Linux strace observes real descriptor operations; Darwin has no strace.
test.skipIf(process.platform !== "linux")("all seed modes precede every per-entry durability barrier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-seed-order-"));
  const seed = join(directory, "seed");
  try {
    await mkdir(seed, { mode: 0o755 });
    const files = Array.from({ length: 64 }, (_, index) => join(seed, `file-${index}`));
    for (const file of files) await writeFile(file, "seed", { mode: 0o644 });
    const child = Bun.spawn(
      [
        "strace",
        "-ff",
        "-ttt",
        "-T",
        "-yy",
        "-e",
        "trace=fchmod,fsync",
        "-o",
        join(directory, "trace"),
        process.execPath,
        join(import.meta.dir, "seed-sync-fixture.ts"),
        seed,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, output] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(output).toBe("");
    const traces = (await readdir(directory)).filter((name) => name.startsWith("trace."));
    const trace = (await Promise.all(traces.map((name) => Bun.file(join(directory, name)).text()))).join("\n");
    const calls = trace.split("\n").flatMap((line) => {
      const match = line.match(/(\d+\.\d+) (fchmod|fsync)\(\d+<([^>]+)>(?:, (0[0-7]+))?\) = 0 <(\d+\.\d+)>/);
      if (!match || !match[3]?.startsWith(seed)) return [];
      const start = Number(match[1]);
      return [
        {
          operation: match[2],
          path: match[3],
          mode: Number.parseInt(match[4] ?? "0", 8),
          start,
          end: start + Number(match[5]),
        },
      ];
    });
    const modes = calls.filter((call) => call.operation === "fchmod");
    const syncs = calls.filter((call) => call.operation === "fsync");
    expect(modes).toHaveLength(files.length + 1);
    expect(syncs).toHaveLength(files.length + 1);
    expect(new Set(modes.map((call) => call.path))).toEqual(new Set([seed, ...files]));
    expect(new Set(syncs.map((call) => call.path))).toEqual(new Set([seed, ...files]));
    for (const call of modes) expect(call.mode).toBe(call.path === seed ? 0o700 : 0o600);
    expect(Math.max(...modes.map((call) => call.end))).toBeLessThanOrEqual(
      Math.min(...syncs.map((call) => call.start)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
