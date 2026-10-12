import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeStartupHooks } from "./native-startup-hooks";

test("a real late first start retains failure, RSS, logs and cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc105-failure-result-"));
  try {
    const binary = join(directory, "slow-controller");
    await Bun.write(
      binary,
      `#!${process.execPath}\nif (process.argv.includes("--version")) { console.log("fixture"); process.exit(0); }
      console.error("late-first-start-fixture");
      setTimeout(() => Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.POCKETCODER_HTTP.split(":")[1]), fetch: () => new Response("ready") }), 3200);
      process.on("SIGTERM", () => process.exit(0));\n`,
    );
    await chmod(binary, 0o755);
    const built = await Bun.build({
      entrypoints: ["scripts/native-startup-runner.ts"],
      target: "bun",
      outdir: directory,
      naming: "runner.js",
      plugins: [nativeStartupHooks()],
    });
    expect(built.success).toBe(true);
    const child = Bun.spawn([process.execPath, join(directory, "runner.js"), binary, "--first-only"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("[startup-spawn] ");
    expect(stderr).toContain("[startup-exit] ");
    expect(stderr).toContain("late-first-start-fixture");
    const result = JSON.parse(stdout.trim());
    expect(result.error).toContain("Controller exceeded 3-second readiness");
    expect(result.error).toContain("late-first-start-fixture");
    expect(result.measurements).toHaveLength(1);
    expect(result.measurements[0].readinessMs).toBeGreaterThan(3000);
    expect(result.measurements[0].peakMemoryBytes).toBeGreaterThan(0);
    expect(result.cleanup).toEqual({ stopped: true, removed: true });
    expect(await Bun.file(join(result.directory, "pocketcoder")).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test.each([undefined, "--first-with-version"])(
  "a real late start preserves the version prelude and first window (%s)",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "pc105-version-failure-"));
    try {
      const binary = join(directory, "slow-controller");
      const events = join(directory, "events.jsonl");
      await Bun.write(
        binary,
        `#!${process.execPath}\nimport { appendFileSync } from "node:fs";
        const event = (phase) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({ phase, epochMs: Date.now() }) + "\\n");
        if (process.argv.includes("--version")) { event("version"); console.log("normal-fixture-version"); process.exit(0); }
        event("serve"); console.error("normal-late-first-fixture");
        setTimeout(() => Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.POCKETCODER_HTTP.split(":")[1]), fetch: () => new Response("ready") }), 3200);
        process.on("SIGTERM", () => { event("term"); process.exit(0); });\n`,
      );
      await chmod(binary, 0o755);
      const built = await Bun.build({
        entrypoints: ["scripts/native-startup-runner.ts"],
        target: "bun",
        outdir: directory,
        naming: "runner.js",
      });
      expect(built.success).toBe(true);
      const args = [process.execPath, join(directory, "runner.js"), binary];
      if (mode) args.push(mode);
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1);
      const result = JSON.parse(stdout.trim());
      const observed = (await Bun.file(events).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(observed.map((entry) => entry.phase)).toEqual(["version", "serve", "term"]);
      expect(result.prelude.output.trim()).toBe("normal-fixture-version");
      expect(result.prelude.startedEpochMs).toBeLessThanOrEqual(observed[0].epochMs);
      expect(result.prelude.finishedEpochMs).toBeGreaterThanOrEqual(observed[0].epochMs);
      expect(result.firstStartedEpochMs).toBeGreaterThanOrEqual(result.prelude.finishedEpochMs);
      expect(result.firstStartedEpochMs).toBeLessThanOrEqual(observed[1].epochMs);
      expect(result.error).toContain("Controller exceeded 3-second readiness");
      expect(result.error).toContain("normal-late-first-fixture");
      expect(result.measurements).toHaveLength(1);
      expect(result.measurements[0].peakMemoryBytes).toBeGreaterThan(0);
      expect(result.cleanup).toEqual({ stopped: true, removed: true });
      expect(await Bun.file(join(result.directory, "pocketcoder")).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);
