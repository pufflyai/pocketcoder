import { expect, test } from "bun:test";
import { fstatSync, readdirSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpointEntryIndex } from "./entry-index";
import { createCheckpointEntrySorter } from "./entry-sort";

function hasPrefix() {
  return readdirSync("/dev/fd").some((name) => {
    try {
      const s = fstatSync(Number(name));
      return s.isFile() && s.nlink === 0 && s.size === 4;
    } catch {
      return false;
    }
  });
}
for (const [name, create] of [
  ["sorter", createCheckpointEntrySorter],
  ["ordered index", createCheckpointEntryIndex],
] as const) {
  for (const action of ["close", "abort"] as const) {
    test(`${name} refuses append after caller ${action} in actual post-prefix check`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "pc-state-review-")));
      const abort = new AbortController();
      let armed = false;
      let closing: Promise<void> | undefined;
      let value: ReturnType<typeof create> | undefined;
      try {
        value = create(root, {
          maxBytes: 100000,
          signal: abort.signal,
          check() {
            if (armed && hasPrefix()) {
              armed = false;
              if (action === "close") closing = value?.close();
              else abort.abort(Error("post-prefix abort"));
            }
          },
        });
        armed = true;
        await expect(
          value.append({ mount: 0, path: "a", kind: "directory", size: 0, mode: 448, mtime_ns: "0" }),
        ).rejects.toThrow(action === "close" ? "closed" : "post-prefix abort");
      } finally {
        await closing;
        await value?.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
