import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { buildServer } from "@pstdio/pocketcoder-server";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { bootstrapExampleOwner, issueExampleAccess } from "./administration";

test("an isolated example bootstraps its owner then uses HTTP for workload authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-example-access-"));
  const pepper = "example-access-test-pepper";
  const expiresAt = new Date(Date.now() + 60_000);
  const ownerKey = await bootstrapExampleOwner(directory, pepper, expiresAt);
  const store = await PGliteStore.create(directory);
  const built = buildServer({
    store,
    driver: new FakeDriver(),
    pepper,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:0",
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: built.app.fetch });
  try {
    const key = await issueExampleAccess(server.url.origin, ownerKey, {
      name: "example-workload",
      scopes: ["templates:read", "workspaces:read"],
      templates: ["echo"],
      expiresAt,
    });
    expect(key).toStartWith("pkt_");
    expect(key).not.toBe(ownerKey);
    const client = new PocketCoderClient({ baseUrl: server.url.origin, apiKey: key });
    await expect(client.principals.list()).rejects.toMatchObject({ code: "auth.missing_scope" });
    const principal = await store.getPrincipalByName("example-workload");
    expect(principal).toMatchObject({ scopes: ["templates:read", "workspaces:read"], templateNames: ["echo"] });
    const inventory = await store.listMachineKeys(principal?.id ?? "", { limit: 10 });
    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.expiresAt).toEqual(expiresAt);
  } finally {
    await server.stop(true);
    await built.scheduler.drain();
    await built.persistence.drain();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
