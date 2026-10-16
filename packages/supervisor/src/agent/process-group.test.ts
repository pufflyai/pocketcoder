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
  };
  try {
    expect(scanGroupWriters(100, proc)).toBe(true);
    writeFileSync(join(root, "101"), "101 (child) Z 1 100");
    expect(scanGroupWriters(100, proc)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
