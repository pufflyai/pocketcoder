import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { authed, createTestServer, SERVER_TEST_PEPPER } from "../testing/test-server.test";

export async function createPrincipalKeyServer(store: Store) {
  const app = await createTestServer(store);
  const owner = await app.store.createPrincipal("owner", ["admin"], ["*"]);
  const customer = await app.store.createPrincipal(
    "customer",
    ["workspaces:read", "workspaces:create"],
    ["fixture-echo"],
  );
  const issued = issueMachineKey(SERVER_TEST_PEPPER);
  const expiresAt = new Date(Date.now() + 3600000);
  await app.store.insertMachineKey({
    id: issued.id,
    principalId: owner.id,
    secretDigest: issued.secretDigest,
    scopes: ["admin"],
    createdAt: new Date(),
    expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  const request = (path: string, init: RequestInit = {}) => app.app.request(path, authed(issued.token, init));
  return { ...app, owner, customer, expiresAt, request };
}
