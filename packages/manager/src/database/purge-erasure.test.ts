import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OffNodeBackupReceiptSchema } from "@pstdio/pocketcoder-db/off-node";
import { createRequestDigest, purgeRequestDigest } from "../purge/intent";
import { usageRepository } from "../usage/repository";
import { accountRepository } from "./account-repository";
import { backupRepository } from "./backup-repository";
import { bootstrapRepository } from "./bootstrap-repository";
import { managerContext } from "./context";

test("purge erases account content and request aliases atomically, including a stale database replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc94-erase-"));
  const directory = join(root, "manager");
  const stale = join(root, "stale");
  let context = await managerContext(directory);
  try {
    const expiry = new Date(Date.now() + 60_000);
    const requestId = randomUUID();
    const plan = {
      controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
      runtimeClassName: "pc-runc",
      offNodeBackups: true,
    };
    const accounts = accountRepository(context);
    const bootstrap = bootstrapRepository(context);
    const created = await accounts.createAccount(requestId, { name: "private account content" }, () => plan, expiry);
    const other = await accounts.createAccount(randomUUID(), { name: "another account" }, () => plan, expiry);
    const operatorToken = await bootstrap.createOperator(expiry);
    await accounts.finishAccount(created.account.id, created.operation.id);
    const owner = await bootstrap.beginBootstrap(
      created.account.id,
      { request_id: randomUUID(), expires_at: expiry.toISOString() },
      expiry,
    );
    await bootstrap.completeBootstrap(owner.id, randomUUID());
    await usageRepository(context).recordUsageSample({
      accountId: created.account.id,
      sampledAt: new Date(),
      workspaces: 2,
      warm: 1,
      volumeBytes: 128,
    });
    const backups = backupRepository(context);
    const backup = await backups.beginBackupOperation(created.account.id, "backup", randomUUID(), expiry);
    // Catalog fixtures prove database erasure, not provider or archive acceptance.
    await backups.saveBackup(
      backup.operation.id,
      OffNodeBackupReceiptSchema.parse({
        accountId: created.account.id,
        operationId: backup.operation.id,
        snapshotId: randomUUID(),
        createdAt: new Date().toISOString(),
        plaintextDigest: `sha256:${"b".repeat(64)}`,
        journal: { journalId: randomUUID(), sequence: 0, digest: "c".repeat(64) },
        sourceWriter: {
          format: "pocketcoder-source-writer/v1",
          directory: "/private/pc_data",
          root: { device: "1", inode: "2" },
          lock: { device: "1", inode: "3" },
        },
        runtimes: [],
        staging: {
          reservationId: randomUUID(),
          archiveBytes: 128,
          contents: { bytes: 64, files: 1, directories: 1 },
          database: { bytes: 64, files: 1, directories: 1 },
        },
        object: {
          key: `accounts/${created.account.id}/catalog-fixture.enc`,
          versionId: randomUUID(),
          etag: "catalog-fixture",
          bytes: 128,
          digest: `sha256:${"d".repeat(64)}`,
        },
      }),
    );
    const intent = {
      format: "pocketcoder-account-purge/v1" as const,
      accountId: created.account.id,
      operationId: randomUUID(),
      createRequestDigest: createRequestDigest(requestId),
      purgeRequestDigest: purgeRequestDigest(randomUUID()),
      admittedAt: new Date().toISOString(),
    };
    await context.close();
    await cp(directory, stale, { recursive: true });
    context = await managerContext(directory);
    const { purgeErasure } = await import("./purge-erasure");
    await expect(
      purgeErasure(context)({ ...intent, createRequestDigest: createRequestDigest(randomUUID()) }),
    ).rejects.toThrow("create identity differs");
    expect(await accountRepository(context).getAccount(created.account.id)).not.toBeNull();
    expect(await context.db.select().from(context.tables.bootstrapRequests)).toHaveLength(1);
    expect(await context.db.select().from(context.tables.backups)).toHaveLength(1);
    expect(await context.db.select().from(context.tables.usageSamples)).toHaveLength(1);
    await purgeErasure(context)(intent);
    const remaining = await accountRepository(context).listAccounts();
    expect(remaining.map((row) => row.id)).toEqual([other.account.id]);
    for (const table of [context.tables.bootstrapRequests, context.tables.backups, context.tables.usageSamples])
      expect(await context.db.select().from(table)).toEqual([]);
    expect((await context.db.select().from(context.tables.operations)).map((row) => row.id)).toEqual([
      other.operation.id,
    ]);
    expect(await bootstrapRepository(context).operator(operatorToken)).not.toBeNull();
    await purgeErasure(context)(intent);
    expect((await accountRepository(context).listAccounts()).map((row) => row.id)).toEqual([other.account.id]);
    await context.close();
    context = await managerContext(stale);
    expect(await accountRepository(context).getAccount(created.account.id)).not.toBeNull();
    await purgeErasure(context)(intent);
    expect(await accountRepository(context).getAccount(created.account.id)).toBeNull();
    // A different UUID from an earlier empty snapshot still belongs to the same original request.
    const alias = await accountRepository(context).createAccount(
      requestId,
      { name: "stale alias" },
      () => plan,
      expiry,
    );
    expect(alias.account.id).not.toBe(intent.accountId);
    await purgeErasure(context)(intent);
    expect(await accountRepository(context).getAccount(alias.account.id)).toBeNull();
    expect((await accountRepository(context).listAccounts()).map((row) => row.id)).toEqual([other.account.id]);
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
