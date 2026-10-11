import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { z } from "zod";
import { createManagerApp } from "../app";
import { ManagerStore } from "../database/store";
import { createRequestDigest, intentKeys, PurgeIntentSchema, purgeRequestDigest } from "./intent";

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "purge admission permanently fences a ready account and returns only identifiers",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-purge-admission-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
    let failure: unknown;
    const errors: unknown[] = [];
    try {
      fixture = await objectStorageFixture();
      store = await ManagerStore.create(join(root, "manager"), {
        directory: join(root, "authority"),
        storage: fixture.config,
      });
      const expiry = new Date(Date.now() + 60_000);
      const token = await store.createOperator(expiry);
      const config = {
        controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
        runtimeClassName: "pc-runc",
      };
      const requestId = "private original request";
      const created = await store.createAccount(requestId, { name: "private account label" }, () => config, expiry);
      await store.finishAccount(created.account.id, created.operation.id);
      const app = createManagerApp(store, config);
      const headers = {
        authorization: `Bearer ${token}`,
        "idempotency-key": "purge-one",
        "content-type": "application/json",
      };
      const path = `/v1/accounts/${created.account.id}`;
      const admitted = await app.request(`${path}/purge`, { method: "POST", headers });
      expect(admitted.status).toBe(202);
      const Operation = z.strictObject({
        id: z.uuid(),
        account_id: z.uuid(),
        kind: z.literal("purge"),
        state: z.literal("pending"),
      });
      const result = z.strictObject({ operation: Operation }).parse(await admitted.json());
      expect(result.operation.account_id).toBe(created.account.id);
      const intent = PurgeIntentSchema.parse(
        await (await fixture.storage.get(`manager/purge/accounts/${created.account.id}/intent.json`)).json(),
      );
      expect(intent.operationId).toBe(result.operation.id);
      expect(intent.createRequestDigest).toBe(createRequestDigest(requestId));
      expect(intent.purgeRequestDigest).toBe(purgeRequestDigest("purge-one"));
      for (const key of intentKeys(intent)) expect(await (await fixture.storage.get(key)).json()).toEqual(intent);
      for (const action of ["suspend", "resume", "backups", "restore", "owner"]) {
        let body: Record<string, string> = {};
        if (action === "restore") body = { backup_id: created.operation.id };
        if (action === "owner") body = { request_id: randomUUID(), expires_at: expiry.toISOString() };
        const response = await app.request(`${path}/${action}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ code: "account_purged" });
      }
      expect((await app.request(path, { headers })).status).toBe(409);
      await expect(store.finishAccount(created.account.id, created.operation.id)).rejects.toThrow("account_purged");
      const repeated = z.strictObject({ operation: Operation }).parse(
        await (
          await app.request(`${path}/purge`, {
            method: "POST",
            headers,
          })
        ).json(),
      );
      expect(repeated.operation.id).toBe(result.operation.id);
      const conflict = await app.request(`${path}/purge`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": "different purge request" },
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ code: "idempotency_conflict" });
      expect(await (await app.request(`/v1/operations/${result.operation.id}`, { headers })).json()).toEqual(
        result.operation,
      );
      expect(JSON.stringify(intent)).not.toContain(requestId);
      expect(JSON.stringify(intent)).not.toContain("private account label");
    } catch (error) {
      failure = error;
    } finally {
      const cleanup = await Promise.allSettled([store?.close(), fixture?.close()]);
      cleanup.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])));
      for (const result of cleanup) if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length)
      throw new AggregateError([...(failure ? [failure] : []), ...errors], "Admission fixture cleanup failed");
    if (failure) throw failure;
  },
  30_000,
);
