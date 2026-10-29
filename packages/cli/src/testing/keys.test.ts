import { expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "@pstdio/pocketcoder-server";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { runCli } from "./cli-test-support";

const createStore = createTestStoreFactory();
const DAY = 86_400_000;

test("key rotation and the expiring-keys list run through the server", async () => {
  const store = await createStore();
  const pepper = "cli-keys-test-pepper";
  const owner = await store.createPrincipal("owner", ["admin"], ["*"]);
  const backend = await store.createPrincipal("backend", ["workspaces:read"], []);
  const ownerKey = issueMachineKey(pepper);
  const backendKey = issueMachineKey(pepper);
  const key = (id: string, principalId: string, scopes: string[], expiresAt: Date) =>
    store.insertMachineKey({
      id,
      principalId,
      secretDigest: (id === ownerKey.id ? ownerKey : backendKey).secretDigest,
      scopes,
      createdAt: new Date(),
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    });
  await key(ownerKey.id, owner.id, ["admin"], new Date(Date.now() + 60 * DAY));
  await key(backendKey.id, backend.id, ["workspaces:read"], new Date(Date.now() + 7 * DAY - 60_000));
  const built = buildServer({
    store,
    driver: new FakeDriver(),
    pepper,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:0",
  });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: built.app.fetch });
  const env = { POCKETCODER_URL: listener.url.origin, POCKETCODER_KEY: ownerKey.token };
  try {
    const expiring = await runCli(["keys", "expiring", "--within-hours", "168"], { env });
    expect(expiring.exitCode).toBe(0);
    expect(JSON.parse(expiring.output).items.map((item: { id: string }) => item.id)).toEqual([backendKey.id]);

    const rotateArguments = ["keys", "rotate", "--principal-id", backend.id, "--id", backendKey.id];
    const rotated = await runCli([...rotateArguments, "--request-id", "cli-rotate", "--json"], { env });
    expect(rotated.exitCode).toBe(0);
    const successor = JSON.parse(rotated.output);
    expect(successor.token).toStartWith("pkt_");
    expect(successor.key).toMatchObject({ principal_id: backend.id, scopes: ["workspaces:read"] });
    expect((await store.getMachineKeyWithPrincipal(backendKey.id))?.key.revokedAt).toBeNull();
  } finally {
    await listener.stop(true);
    await built.scheduler.drain();
    await built.persistence.drain();
  }
});
