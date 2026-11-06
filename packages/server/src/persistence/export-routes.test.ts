import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { WorkspaceResourceSchema } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

test("invalid export object identities return not found instead of a database error", async () => {
  const store = await createStore();
  const server = await createTestServer(store, { globalActiveWorkspaces: 0 });
  const owner = await store.getMachineKeyWithPrincipal(server.keyId);
  if (!owner) throw new Error("Missing test owner");
  await store.updatePrincipal(owner.principal.id, ["admin"], ["*"]);
  const response = await server.app.request(
    "/v1/workspaces",
    authed(server.token, {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      body: createTestBody(),
    }),
  );
  expect(response.status).toBe(201);
  const { id } = WorkspaceResourceSchema.parse(await response.json());
  for (const objectId of ["not-a-uuid", "1234", "00000000-0000-0000-0000-invalid-value", randomUUID()]) {
    const content = await server.app.request(`/v1/workspaces/${id}/exports/${objectId}/content`, authed(server.token));
    expect(content.status).toBe(404);
    expect(await content.json()).toMatchObject({ error: { code: "workspace.not_found" } });
  }
});
