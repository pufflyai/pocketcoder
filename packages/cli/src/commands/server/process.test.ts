import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printManagedServerStatus } from "./process";

const dirs: string[] = [];
const originalStateDir = process.env.POCKETCODER_STATE_DIR;
const originalExitCode = process.exitCode;

function emptyStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pcd-server-status-"));
  dirs.push(dir);
  process.env.POCKETCODER_STATE_DIR = dir;
  return dir;
}

function captureLogs(): string[] {
  const lines: string[] = [];
  console.log = (value?: unknown) => {
    lines.push(String(value));
  };
  return lines;
}

afterEach(() => {
  console.log = originalLog;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env.POCKETCODER_STATE_DIR;
  else process.env.POCKETCODER_STATE_DIR = originalStateDir;
  process.exitCode = originalExitCode ?? 0;
});

const originalLog = console.log;

describe("managed server status", () => {
  test("reports not_running instead of throwing when no state exists", async () => {
    emptyStateDir();
    const lines = captureLogs();

    await printManagedServerStatus(false);

    expect(lines).toEqual(["not_running (no managed server state)"]);
    expect(process.exitCode).toBe(1);
  });

  test("reports not_running as JSON when requested", async () => {
    emptyStateDir();
    const lines = captureLogs();

    await printManagedServerStatus(true);

    expect(lines.map((line) => JSON.parse(line))).toEqual([{ state: "not_running" }]);
    expect(process.exitCode).toBe(1);
  });
});
