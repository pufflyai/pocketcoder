import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpointEntryIndex } from "./entry-index";

test.each(["lookup", "ordinal", "entryAt"] as const)(
  "sealed %s refuses close between native reads and acceptance",
  async (method) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pc-index-close-review-")));
    let accepted = 0;
    try {
      for (let target = 1; target <= 64; target++) {
        let armed = false;
        let calls = 0;
        let closing: Promise<void> | undefined;
        const index = createCheckpointEntryIndex(root, {
          maxBytes: 10000,
          check() {
            if (armed && ++calls === target)
              queueMicrotask(() => {
                closing = index.close();
              });
          },
        });
        try {
          await index.append({ mount: 0, path: "a", kind: "directory", size: 0, mode: 0o700, mtime_ns: "0" });
          const sealed = index.seal();
          armed = true;
          let resolved = false;
          try {
            await (method === "entryAt" ? sealed.entryAt(0) : sealed[method](0, "a"));
            resolved = true;
          } catch {}
          if (resolved && closing) {
            console.log(`accepted ${method} after closing at check ${target}`);
            accepted++;
          }
        } finally {
          await index.close().catch(() => {});
        }
      }
      expect(accepted).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("empty sealed iteration refuses late close before accepting EOF", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-index-eof-review-")));
  let accepted = 0;
  try {
    for (let target = 1; target <= 32; target++) {
      let armed = false;
      let calls = 0;
      let closing: Promise<void> | undefined;
      const index = createCheckpointEntryIndex(root, {
        maxBytes: 10000,
        check() {
          if (armed && ++calls === target)
            queueMicrotask(() => {
              closing = index.close();
            });
        },
      });
      try {
        const sealed = index.seal();
        armed = true;
        let resolved = false;
        try {
          await sealed.entries().next();
          resolved = true;
        } catch {}
        if (resolved && closing) accepted++;
      } finally {
        await index.close().catch(() => {});
      }
    }
    expect(accepted).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
