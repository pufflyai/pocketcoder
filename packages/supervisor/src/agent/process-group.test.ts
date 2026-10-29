import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanGroupWriters } from "./process-group";

test.each(["fork", "exit"])("a %s during enumeration cannot prove the group stopped", (change) => {
  const root = mkdtempSync(join(tmpdir(), "pc-proc-scan-"));
  writeFileSync(join(root, "100"), "100 (parent) S 1 100");
  let inventories = 0;
  const proc = {
    pids() {
      const before = readdirSync(root);
      if (inventories++ === 0) {
        // The parent can fork after enumeration and exit before its stat is read.
        writeFileSync(join(root, "101"), "101 (child) S 1 100");
        if (change === "fork") writeFileSync(join(root, "100"), "100 (parent) Z 1 100");
        else unlinkSync(join(root, "100"));
      }
      return before;
    },
    stat: (pid: string) => readFileSync(join(root, pid), "utf8"),
    tasks: (pid: string) => [pid],
    taskStat: (_pid: string, tid: string) => readFileSync(join(root, tid), "utf8"),
  };
  try {
    expect(scanGroupWriters(100, proc)).toBe(true);
    writeFileSync(join(root, "101"), "101 (child) Z 1 100");
    expect(scanGroupWriters(100, proc)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a zombie main thread does not prove its live worker threads stopped", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-thread-scan-"));
  writeFileSync(join(root, "100"), "100 (main) Z 1 100");
  writeFileSync(join(root, "101"), "101 (worker) S 1 100");
  const proc = {
    pids: () => ["100"],
    stat: (pid: string) => readFileSync(join(root, pid), "utf8"),
    tasks: () => readdirSync(root),
    taskStat: (_pid: string, tid: string) => readFileSync(join(root, tid), "utf8"),
  };
  try {
    expect(scanGroupWriters(100, proc)).toBe(true);
    writeFileSync(join(root, "101"), "101 (worker) Z 1 100");
    expect(scanGroupWriters(100, proc)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a thread created during enumeration cannot escape the writer barrier", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-thread-churn-"));
  writeFileSync(join(root, "100"), "100 (main) Z 1 100");
  writeFileSync(join(root, "101"), "101 (worker) S 1 100");
  let inventories = 0;
  const proc = {
    pids: () => ["100"],
    stat: (pid: string) => readFileSync(join(root, pid), "utf8"),
    tasks() {
      const before = readdirSync(root);
      if (inventories++ === 0) {
        writeFileSync(join(root, "102"), "102 (new worker) S 1 100");
        writeFileSync(join(root, "101"), "101 (old worker) Z 1 100");
      }
      return before;
    },
    taskStat: (_pid: string, tid: string) => readFileSync(join(root, tid), "utf8"),
  };
  try {
    expect(scanGroupWriters(100, proc)).toBe(true);
    writeFileSync(join(root, "102"), "102 (new worker) Z 1 100");
    expect(scanGroupWriters(100, proc)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
