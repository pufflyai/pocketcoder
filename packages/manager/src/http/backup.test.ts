import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createManagerApp } from "../app";
import { ManagerStore } from "../database/store";

test("one backup operation survives manager restart and blocks a concurrent suspend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc93-manager-backup-"));
  let store = await ManagerStore.create(directory);
  try {
    const expiry = new Date(Date.now() + 60_000);
    const token = await store.createOperator(expiry);
    const config = {
      controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
      runtimeClassName: "pc-runc",
      offNodeBackups: true,
    };
    const created = await store.createAccount("one", { name: "one" }, config, expiry);
    await store.finishAccount(created.account.id, created.operation.id);
    const headers = { authorization: `Bearer ${token}`, "idempotency-key": "backup-one" };
    const path = `/v1/accounts/${created.account.id}/backups`;
    let app = createManagerApp(store, config);
    const admitted = await app.request(path, { method: "POST", headers });
    expect(admitted.status).toBe(202);
    const Response = z.object({
      operation: z.object({ id: z.uuid(), kind: z.string() }),
      account: z.object({ state: z.string() }),
    });
    const result = Response.parse(await admitted.json());
    expect(result.operation.kind).toBe("backup");
    expect(result.account.state).toBe("ready");
    expect(
      (
        await app.request(`/v1/accounts/${created.account.id}/suspend`, {
          method: "POST",
          headers: { ...headers, "idempotency-key": "suspend" },
        })
      ).status,
    ).toBe(409);
    await store.close();
    store = await ManagerStore.create(directory);
    app = createManagerApp(store, config);
    const repeated = await app.request(path, { method: "POST", headers });
    expect(repeated.status).toBe(202);
    expect(Response.parse(await repeated.json()).operation.id).toBe(result.operation.id);
    expect(await store.pendingOperations()).toMatchObject([
      { id: result.operation.id, kind: "backup", phase: "capture" },
    ]);
    expect(
      (
        await app.request(`/v1/accounts/${created.account.id}/restore`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json", "idempotency-key": "restore" },
          body: JSON.stringify({ backup_id: result.operation.id }),
        })
      ).status,
    ).toBe(409);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
