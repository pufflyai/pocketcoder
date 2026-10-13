import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createManagerApp } from "@pstdio/pocketcoder-manager";
import { managerBackupProbe, managerMonitoring } from "@pstdio/pocketcoder-manager/monitoring";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { monitoringFixture } from "../../examples/e2e/monitoring-fixture";
import { captureDailyManagerBackup } from "../recovery/manager-backup";

test("manager backup failures and stale recovery points reach the operator and resolve", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc103-manager-alerts-"));
  const storage = await objectStorageFixture();
  const dataDir = join(root, "manager");
  const purgeConfig = join(root, "purge.json");
  const backupConfig = join(root, "backup.json");
  const encryptionKeyFile = join(root, "key");
  const directory = join(root, "receipts");
  const purge = { directory: join(root, "authority"), storage: storage.config };
  await writeFile(encryptionKeyFile, randomBytes(32), { mode: 0o600 });
  await writePrivateJson(purgeConfig, purge);
  await writePrivateJson(backupConfig, { storage: storage.config, encryptionKeyFile });
  const input = { dataDir, purgeConfig, backupConfig, directory };
  let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
  let monitoring: ReturnType<typeof managerMonitoring> | undefined;
  let alerts: Awaited<ReturnType<typeof monitoringFixture>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    store = await ManagerStore.create(dataDir, purge);
    const token = await store.createOperator(new Date(Date.now() + 3600_000), "metrics");
    await store.close();
    store = undefined;
    const receipt = await captureDailyManagerBackup(input);
    const probe = managerBackupProbe(directory, receipt.journal.journalId);
    let app: ReturnType<typeof createManagerApp>;
    async function startManager() {
      const activeStore = await ManagerStore.create(dataDir, purge);
      const activeMonitoring = managerMonitoring(activeStore, { backup: probe });
      store = activeStore;
      monitoring = activeMonitoring;
      await activeMonitoring.sample();
      app = createManagerApp(
        activeStore,
        {
          controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
          runtimeClassName: "pc-runc",
        },
        undefined,
        activeMonitoring,
      );
      return { store: activeStore, monitoring: activeMonitoring };
    }
    let active = await startManager();
    server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: (request) => app.fetch(request) });
    alerts = await monitoringFixture({ token, target: `host.docker.internal:${server.port}`, thresholds: {} });

    alerts.startFault("manager-backup");
    await expect(captureDailyManagerBackup(input)).rejects.toThrow("data folder is in use");
    await active.monitoring.sample();
    await alerts.firing("manager-backup", 30_000, { alertname: "PocketcoderManagerBackupFailure" });
    await active.monitoring.close();
    await active.store.close();
    store = undefined;
    await captureDailyManagerBackup(input);
    active = await startManager();
    await alerts.resolved("manager-backup");

    const health = await Bun.file(join(directory, "health.json")).json();
    const receiptFile = join(directory, health.receiptFile);
    alerts.startFault("manager-backup");
    await writePrivateJson(receiptFile, { ...receipt, createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
    await active.monitoring.sample();
    await alerts.firing("manager-backup", 30_000, { alertname: "PocketcoderManagerBackupAge" });
    await writePrivateJson(receiptFile, receipt);
    await active.monitoring.sample();
    await alerts.resolved("manager-backup");

    alerts.startFault("manager-backup");
    await writePrivateJson(join(directory, "health.json"), {
      ...health,
      result: "started",
      attemptedAt: new Date(Date.now() - 21 * 60_000).toISOString(),
    });
    await active.monitoring.sample();
    await alerts.firing("manager-backup", 30_000, { alertname: "PocketcoderManagerBackupFailure" });
    expect(await alerts.query("pocketcoder_manager_backup_in_progress_seconds")).toBeGreaterThan(1200);
    await writePrivateJson(join(directory, "health.json"), health);
    await active.monitoring.sample();
    await alerts.resolved("manager-backup");

    alerts.startFault("manager-backup");
    await rename(directory, `${directory}.held`);
    await active.monitoring.sample();
    await alerts.firing("manager-backup", 30_000, { alertname: "PocketcoderManagerBackupObservationGap" });
    await rename(`${directory}.held`, directory);
    await active.monitoring.sample();
    await alerts.resolved("manager-backup");
  } finally {
    await alerts?.close();
    await server?.stop(true);
    await monitoring?.close();
    await store?.close();
    await storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
