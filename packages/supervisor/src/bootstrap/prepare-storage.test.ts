import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareStorage } from "./prepare-storage";

test("private owned roots do not pass Kubernetes setgid to captured directories", () => {
  const directory = mkdtempSync(join(tmpdir(), "pc-storage-init-"));
  try {
    chmodSync(directory, 0o2770);
    prepareStorage({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, targets: [directory] });
    expect(statSync(directory).mode & 0o7777).toBe(0o700);
    mkdirSync(join(directory, "child"));
    expect(statSync(join(directory, "child")).mode & 0o2000).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
