import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPort } from "./chromium-startup.fixture";

test("browser startup reports an exited child without waiting for readiness", async () => {
  const profile = await mkdtemp(join(tmpdir(), "pocketcoder-browser-exit-"));
  const child = Bun.spawn([process.execPath, "-e", "process.exit(7)"], { stdout: "ignore", stderr: "ignore" });
  try {
    await child.exited;
    const start = Date.now();
    await expect(browserPort(profile, child, process.execPath)).rejects.toThrow(
      `Chromium exited before readiness: executable=${process.execPath}, pid=${child.pid}, exitCode=7, signal=null`,
    );
    expect(Date.now() - start).toBeLessThan(1000);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}, 10_000);

test("browser startup reports a signal-killed child without waiting for readiness", async () => {
  const profile = await mkdtemp(join(tmpdir(), "pocketcoder-browser-signal-"));
  const child = Bun.spawn([process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    reader.releaseLock();
    child.kill("SIGTERM");
    await child.exited;
    const start = Date.now();
    await expect(browserPort(profile, child, process.execPath)).rejects.toThrow(
      `Chromium exited before readiness: executable=${process.execPath}, pid=${child.pid}, exitCode=null, signal=SIGTERM`,
    );
    expect(Date.now() - start).toBeLessThan(1000);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await rm(profile, { recursive: true, force: true });
  }
}, 10_000);
