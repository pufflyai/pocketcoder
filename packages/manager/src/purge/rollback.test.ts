import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createManagerApp } from "../app";
import { ManagerStore } from "../database/store";
import { purgeRequestDigest } from "./intent";

const enabled = process.env.PC94_S3_TEST === "1";
const config = {
  controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
  runtimeClassName: "pc-runc",
};

test.skipIf(!enabled)(
  "an independent purge intent fences an actual stale manager database",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-manager-rollback-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
    let failure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      fixture = await objectStorageFixture();
      const directory = join(root, "manager");
      const stale = join(root, "stale-manager");
      const authority = join(root, "purge-authority");
      store = await ManagerStore.create(directory);
      const expiry = new Date(Date.now() + 60_000);
      const token = await store.createOperator(expiry);
      const requestId = "customer supplied request text must not survive purge";
      const created = await store.createAccount(requestId, { name: "private account name" }, () => config, expiry);
      expect((await store.pendingOperations()).map((operation) => operation.id)).toEqual([created.operation.id]);
      await store.close();
      store = undefined;
      await cp(directory, stale, { recursive: true });

      const requestDigest = createHash("sha256").update(`pocketcoder-create-request/v1\0${requestId}`).digest("hex");
      const intent = {
        format: "pocketcoder-account-purge/v1",
        accountId: created.account.id,
        operationId: randomUUID(),
        createRequestDigest: requestDigest,
        purgeRequestDigest: purgeRequestDigest("purge this account"),
        admittedAt: new Date().toISOString(),
      };
      await writePrivateJson(join(authority, "intents", `${intent.accountId}.json`), intent, 65_536);
      for (const key of [
        `manager/purge/accounts/${intent.accountId}/intent.json`,
        `manager/purge/requests/${requestDigest}/intent.json`,
      ]) {
        const receipt = await fixture.storage.put(key, Buffer.from(JSON.stringify(intent)));
        expect(await (await fixture.storage.get(key, receipt.versionId)).json()).toEqual(intent);
      }

      store = await ManagerStore.create(stale, { directory: authority, storage: fixture.config });
      const app = createManagerApp(store, config);
      const headers = {
        authorization: `Bearer ${token}`,
        "idempotency-key": requestId,
        "content-type": "application/json",
      };
      const replay = await app.request("/v1/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "private account name" }),
      });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual({ code: "account_purged" });
      expect(await store.pendingOperations()).toEqual([]);
      await expect(store.finishAccount(intent.accountId, created.operation.id)).rejects.toThrow("account_purged");
      await expect(
        store.beginBootstrap(intent.accountId, { request_id: randomUUID(), expires_at: expiry.toISOString() }, expiry),
      ).rejects.toThrow("account_purged");
      const intentBytes = JSON.stringify(intent);
      expect(intentBytes).not.toContain(requestId);
      expect(intentBytes).not.toContain("private account name");
    } catch (error) {
      failure = error;
    } finally {
      const cleaned = await Promise.allSettled([store?.close(), fixture?.close()]);
      cleaned.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])));
      for (const result of cleaned) if (result.status === "rejected") cleanupFailures.push(result.reason);
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        [...(failure ? [failure] : []), ...cleanupFailures],
        "Owned purge fixture cleanup failed",
      );
    if (failure) throw failure;
  },
  30_000,
);
