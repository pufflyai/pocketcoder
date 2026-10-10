import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createManagerApp } from "../app";
import { ManagerStore } from "../database/store";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("suspend admission persists one operation across HTTP retry and manager restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-manager-suspend-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let store = await ManagerStore.create(directory);
  cleanup.push(() => store.close());
  const expiry = new Date(Date.now() + 60_000);
  const token = await store.createOperator(expiry);
  const config = { controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`, runtimeClassName: "pc-runc" };
  const created = await store.createAccount("one", { name: "one" }, config, expiry);
  await store.finishAccount(created.account.id, created.operation.id);
  let app = createManagerApp(store, config);
  const headers = { authorization: `Bearer ${token}`, "idempotency-key": "suspend-one" };
  const path = `/v1/accounts/${created.account.id}/suspend`;
  const first = await app.request(path, { method: "POST", headers });
  expect(first.status).toBe(202);
  const response = z.object({
    account: z.object({ state: z.string() }),
    operation: z.object({ kind: z.string(), id: z.uuid() }),
  });
  const result = response.parse(await first.json());
  expect(result.account.state).toBe("suspending");
  expect(result.operation.kind).toBe("suspend");
  expect((await app.request(`/v1/accounts/${created.account.id}/resume`, { method: "POST", headers })).status).toBe(
    409,
  );
  await store.close();
  store = await ManagerStore.create(directory);
  app = createManagerApp(store, config);
  const repeated = await app.request(path, { method: "POST", headers });
  expect(repeated.status).toBe(202);
  expect(response.parse(await repeated.json()).operation.id).toBe(result.operation.id);
  expect(await store.pendingOperations()).toMatchObject([{ id: result.operation.id, kind: "suspend" }]);
  expect(
    (
      await app.request(`/v1/accounts/${created.account.id}/owner`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ request_id: crypto.randomUUID(), expires_at: expiry.toISOString() }),
      })
    ).status,
  ).toBe(409);
});
