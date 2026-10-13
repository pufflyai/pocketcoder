import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { issueOperators } from "./operators";

test("deployment issues private finite schedule and metrics keys against the real manager", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc103-deployment-"));
  const store = await ManagerStore.create(join(root, "manager"));
  try {
    const directory = join(root, "private");
    const expiry = new Date(Date.now() + 20 * 3600_000);
    await issueOperators(store, directory, expiry);
    for (const [file, purpose] of [
      ["schedule-operator-token", "operator"],
      ["metrics-operator-token", "metrics"],
    ] as const) {
      const path = join(directory, file);
      const token = (await Bun.file(path).text()).trim();
      expect(await store.operator(token)).toMatchObject({ purpose, expiresAt: expiry });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    const old = await Bun.file(join(directory, "schedule-operator-token")).text();
    await issueOperators(store, directory, expiry);
    expect(await Bun.file(join(directory, "schedule-operator-token")).text()).not.toBe(old);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await expect(issueOperators(store, directory, new Date(Date.now() + 25 * 3600_000))).rejects.toThrow();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
