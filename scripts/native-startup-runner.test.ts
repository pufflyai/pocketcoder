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
