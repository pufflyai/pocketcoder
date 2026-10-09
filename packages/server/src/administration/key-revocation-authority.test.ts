import { expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, SERVER_TEST_PEPPER } from "../testing/test-server.test";
import { createPrincipalKeyServer } from "./principal-test-fixtures";

const createStore = createTestStoreFactory();

function barrier() {
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    arrived: arrived.promise,
    release: () => released.resolve(),
    async pause() {
      arrived.resolve();
      await released.promise;
    },
  };
}

for (const operation of ["single", "all"] as const) {
  for (const change of [
    "target scopes",
    "target templates",
    "caller scopes",
    "caller templates",
    "caller revoked",
    "caller disabled",
  ] as const) {
    test(`${operation} key revocation rechecks ${change} at the real mutation boundary`, async () => {
      const app = await createPrincipalKeyServer(await createStore());
      const caller = await app.store.createPrincipal(
        "issuer",
        ["keys:write", "workspaces:read", "workspaces:create"],
        ["fixture-echo"],
      );
      const issuerKey = issueMachineKey(SERVER_TEST_PEPPER);
      const targetKey = issueMachineKey(SERVER_TEST_PEPPER);
      for (const [principal, key] of [
        [caller, issuerKey],
        [app.customer, targetKey],
      ] as const) {
        await app.store.insertMachineKey({
          id: key.id,
          principalId: principal.id,
          secretDigest: key.secretDigest,
          scopes: principal.scopes,
          templateNames: principal.templateNames,
          createdAt: new Date(),
          expiresAt: app.expiresAt,
          revokedAt: null,
          lastUsedAt: null,
        });
      }
      const gate = barrier();
      const single = app.store.revokeMachineKey.bind(app.store);
      const all = app.store.revokePrincipalKeys.bind(app.store);
      // Pause scheduling only; every authority read and mutation uses the real store.
      if (operation === "single") {
        app.store.revokeMachineKey = async (...args) => {
          await gate.pause();
          return single(...args);
        };
      } else {
        app.store.revokePrincipalKeys = async (...args) => {
          await gate.pause();
          return all(...args);
        };
      }
      const path = `/v1/principals/${app.customer.id}/keys${operation === "single" ? `/${targetKey.id}` : ""}`;
      const pending = app.app.request(path, authed(issuerKey.token, { method: "DELETE" }));
      try {
        await gate.arrived;
        switch (change) {
          case "target scopes":
            await app.store.updatePrincipal(app.customer.id, ["admin"], app.customer.templateNames);
            break;
          case "target templates":
            await app.store.updatePrincipal(app.customer.id, app.customer.scopes, ["*"]);
            break;
          case "caller scopes":
            await app.store.updatePrincipal(caller.id, ["workspaces:read", "workspaces:create"], caller.templateNames);
            break;
          case "caller templates":
            await app.store.updatePrincipal(caller.id, caller.scopes, []);
            break;
          case "caller revoked":
            await single(issuerKey.id, new Date());
            break;
          case "caller disabled":
            await app.store.setPrincipalDisabled(caller.id, true);
            break;
        }
        gate.release();
        const response = await pending;
        const expectedStatus = {
          "target scopes": 404,
          "target templates": 404,
          "caller scopes": 403,
          "caller templates": 404,
          "caller revoked": 401,
          "caller disabled": 403,
        }[change];
        expect(response.status).toBe(expectedStatus);
        expect((await app.store.getPrincipal(app.customer.id))?.disabledAt).toBeNull();
        expect((await app.store.getMachineKeyWithPrincipal(targetKey.id))?.key.revokedAt).toBeNull();
      } finally {
        gate.release();
        await pending;
      }
    });
  }
}

for (const operation of ["single", "all"] as const) {
  test(`${operation} revocation preserves exact recovery delegation for disabled stronger targets`, async () => {
    const app = await createPrincipalKeyServer(await createStore());
    const recovery = issueMachineKey(SERVER_TEST_PEPPER);
    const targetKey = issueMachineKey(SERVER_TEST_PEPPER);
    await app.store.insertMachineKey({
      id: targetKey.id,
      principalId: app.customer.id,
      secretDigest: targetKey.secretDigest,
      scopes: app.customer.scopes,
      createdAt: new Date(),
      expiresAt: app.expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    });
    await app.store.insertMachineKey({
      id: recovery.id,
      principalId: app.owner.id,
      secretDigest: recovery.secretDigest,
      scopes: ["keys:write", "workspaces:recover"],
      templateNames: [],
      managedPrincipalIds: [app.customer.id],
      createdAt: new Date(),
      expiresAt: app.expiresAt,
      revokedAt: null,
      lastUsedAt: null,
    });
    await app.store.updatePrincipal(app.customer.id, ["admin"], ["*"]);
    await app.store.setPrincipalDisabled(app.customer.id, true);
    const suffix = operation === "single" ? `/${targetKey.id}` : "";
    const request = (id: string) =>
      app.app.request(`/v1/principals/${id}/keys${suffix}`, authed(recovery.token, { method: "DELETE" }));
    expect((await request(app.owner.id)).status).toBe(404);
    expect((await request(app.customer.id)).status).toBe(200);
    expect((await app.store.getMachineKeyWithPrincipal(targetKey.id))?.key.revokedAt).toBeInstanceOf(Date);
    expect((await app.store.getMachineKeyWithPrincipal(recovery.id))?.key.revokedAt).toBeNull();
  });
}
