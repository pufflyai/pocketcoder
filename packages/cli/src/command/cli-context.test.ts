import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { withStore } from "./cli-context";

test("local commands persist rows and release the writer lock, including after failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pc-cli-store-"));
  const previous = process.env.POCKETCODER_DIR;
  try {
    process.env.POCKETCODER_DIR = dir;
    await withStore(async (store) => {
      await store.createPrincipal("operator", ["admin"], ["*"]);
    });
    await expect(
      withStore(async () => {
        throw new Error("command failed");
      }),
    ).rejects.toThrow("command failed");
    const reopened = await PGliteStore.create(dir);
    try {
      expect((await reopened.getPrincipalByName("operator"))?.name).toBe("operator");
    } finally {
      await reopened.close();
    }
  } finally {
    if (previous === undefined) delete process.env.POCKETCODER_DIR;
    else process.env.POCKETCODER_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
