import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { backupAccounts } from "../../deploy/recovery/account-backups";
import { captureDailyManagerBackup } from "../../deploy/recovery/manager-backup";
import { managedPurgeFixture } from "./managed-purge-fixture";

const fixture = await managedPurgeFixture();
let timer: ReturnType<typeof setInterval> | undefined;
try {
  const response = await fixture.request("/v1/accounts", {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: JSON.stringify({ name: "scheduled encrypted backup proof" }),
  });
  if (response.status !== 202) throw new Error("Account admission failed.");
  const { account } = (await response.json()) as { account: { id: string } };
  await fixture.reconcile();
  const tokenFile = join(fixture.cluster.directory, "schedule-token");
  await writeFile(tokenFile, fixture.operatorToken, { mode: 0o600 });
  // Reconciliation uses the real controller and versioned object store.
  timer = setInterval(
    () => void Promise.resolve(fixture.reconcile()).catch(() => console.error("Backup reconciliation failed.")),
    2000,
  );
  const config = { managerUrl: "", tokenFile };
  // The fixture routes finite authority through its own listener; retain that address without printing a key.
  const inventoryResponse = await fixture.request("/v1/accounts");
  config.managerUrl = new URL(inventoryResponse.url).origin;
  const first = await backupAccounts(config);
  const repeated = await backupAccounts(config);
  if (first.completed.length !== 1 || JSON.stringify(repeated) !== JSON.stringify(first))
    throw new Error("Scheduled account backup replay differs.");
  const versions = await fixture.storage.storage.storage.versions(`accounts/${account.id}/backups/`);
  if (versions.filter(({ deleted }) => !deleted).length !== 1)
    throw new Error("Scheduled account backup created duplicate versions.");
  clearInterval(timer);
  timer = undefined;
  await fixture.stopManager();
  const backupConfig = join(fixture.cluster.directory, "scheduled-host-backup.json");
  const original = await Bun.file(fixture.backupConfig).json();
  await writeFile(backupConfig, JSON.stringify({ ...original, storage: fixture.storage.storage.config }), {
    mode: 0o600,
  });
  const manager = {
    dataDir: fixture.directory,
    purgeConfig: fixture.purgeConfig,
    backupConfig,
    directory: join(fixture.cluster.directory, "scheduled-manager-receipts"),
  };
  const receipt = await captureDailyManagerBackup(manager);
  if (JSON.stringify(await captureDailyManagerBackup(manager)) !== JSON.stringify(receipt))
    throw new Error("Scheduled manager backup replay differs.");
  await fixture.openManager();
  const backups = (await (await fixture.request(`/v1/accounts/${account.id}/backups`)).json()) as {
    items: { id: string }[];
  };
  if (backups.items.length !== 1 || backups.items[0]?.id !== first.completed[0])
    throw new Error("Manager restart lost the account backup inventory.");
  console.log(
    JSON.stringify({
      scheduledBackupsPassed: {
        account: account.id,
        accountOperation: first.completed[0],
        managerOperation: receipt.operationId,
        managerRecoveryPoint: receipt.createdAt,
        encrypted: true,
        duplicateVersions: false,
        runtime: "Owned Kind and RustFS; hosted node failure remains unproven",
      },
    }),
  );
} finally {
  if (timer) clearInterval(timer);
  await fixture.close();
}
