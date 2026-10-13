import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagerApp } from "@pstdio/pocketcoder-manager";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { backupAccounts } from "./account-backups";

test("daily retries keep one durable backup operation and never report a pending capture as complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc103-backup-cycle-"));
  let store = await ManagerStore.create(join(directory, "manager"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const expiresAt = new Date(Date.now() + 60_000);
    const tokenFile = join(directory, "operator-token");
    await writeFile(tokenFile, await store.createOperator(expiresAt), { mode: 0o600 });
    const config = {
      controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
      runtimeClassName: "pc-runc",
      offNodeBackups: true,
    };
    const { account, operation } = await store.createAccount("daily-fixture", { name: "one" }, () => config, expiresAt);
    await store.finishAccount(account.id, operation.id);
    const run = async () => {
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createManagerApp(store, config).fetch });
      const failure = await backupAccounts({ managerUrl: server.url.toString(), tokenFile, timeoutMs: 50 }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0].message).toContain("Backup remains pending");
      await server.stop(true);
    };
    await run();
    const first = await store.pendingOperations();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ accountId: account.id, kind: "backup" });
    expect(first[0]?.requestId).toMatch(/^scheduled\/\d{4}-\d{2}-\d{2}T(00|12)$/);
    await store.close();
    store = await ManagerStore.create(join(directory, "manager"));
    await run();
    expect((await store.pendingOperations()).map(({ id }) => id)).toEqual(first.map(({ id }) => id));
    expect(await store.listBackups(account.id)).toEqual([]);
  } finally {
    await server?.stop(true);
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("all ready accounts are admitted before the first pending capture is polled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc103-backup-peers-"));
  const store = await ManagerStore.create();
  const tokenFile = join(directory, "operator-token");
  const expiry = new Date(Date.now() + 60_000);
  await writeFile(tokenFile, await store.createOperator(expiry), { mode: 0o600 });
  const config = {
    controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
    runtimeClassName: "pc-runc",
    offNodeBackups: true,
  };
  for (const name of ["blocked capture", "healthy peer"]) {
    const { account, operation } = await store.createAccount(name, { name }, () => config, expiry);
    await store.finishAccount(account.id, operation.id);
  }
  const app = createManagerApp(store, config);
  let pendingAtFirstPoll: number | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (pendingAtFirstPoll === undefined && new URL(request.url).pathname.startsWith("/v1/operations/"))
        pendingAtFirstPoll = (await store.pendingOperations()).length;
      return app.fetch(request);
    },
  });
  try {
    await expect(backupAccounts({ managerUrl: server.url.toString(), tokenFile, timeoutMs: 50 })).rejects.toThrow(
      "Account backup cycle failed",
    );
    expect(pendingAtFirstPoll).toBe(2);
    expect(await store.pendingOperations()).toHaveLength(2);
  } finally {
    await server.stop(true);
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("metrics authority cannot start the backup schedule", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc103-backup-authority-"));
  const store = await ManagerStore.create();
  const tokenFile = join(directory, "metrics-token");
  await writeFile(tokenFile, await store.createOperator(new Date(Date.now() + 60_000), "metrics"), { mode: 0o600 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createManagerApp(store, {
      controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
      runtimeClassName: "pc-runc",
    }).fetch,
  });
  try {
    await expect(backupAccounts({ managerUrl: server.url.toString(), tokenFile })).rejects.toThrow("HTTP 403");
    expect(await store.pendingOperations()).toEqual([]);
  } finally {
    await server.stop(true);
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
