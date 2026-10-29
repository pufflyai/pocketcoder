import { expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { authed, createTestBody, createTestServer } from "../testing/test-server.test";

const createStore = createTestStoreFactory();

// With several database connections, admission can win between cancel's read and its write.
test("a cancel that loses the race to admission still terminates the workspace", async () => {
  const store = await createStore();
  let admitBeforeCancel: string | undefined;
  const racing = new Proxy(store, {
    get(target, property, receiver) {
      if (property !== "transition") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<Store["transition"]>) => {
        if (args[0] === admitBeforeCancel) {
          admitBeforeCancel = undefined;
          await target.claimWorkspaceAdmission({
            workspaceId: args[0],
            at: new Date(),
            registrationDigest: new Uint8Array([1]),
            registrationExpiresAt: new Date(Date.now() + 60_000),
            limits: { globalActiveWorkspaces: 10, perPrincipalActiveWorkspaces: 10, perTemplateActiveWorkspaces: {} },
          });
        }
        return target.transition(...args);
      };
    },
  }) as Store;
  const server = await createTestServer(racing, { globalActiveWorkspaces: 0 });
  const created = await server.app.request(
    "/v1/workspaces",
    authed(server.token, { method: "POST", headers: { "idempotency-key": "race" }, body: createTestBody("race") }),
  );
  const { id } = (await created.json()) as { id: string };
  admitBeforeCancel = id;
  const cancel = await server.app.request(`/v1/workspaces/${id}/cancel`, authed(server.token, { method: "POST" }));
  expect(cancel.status).toBe(200);
  expect(["terminating", "canceled"]).toContain(((await cancel.json()) as { state: string }).state);
});
