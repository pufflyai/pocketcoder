import { accountService, createManagerApp, usageSampler } from "./app";
import { loadManagerBackupConfig } from "./backup/config";
import { ManagerConfigSchema } from "./config";
import { ManagerStore } from "./database/store";
import { KubernetesAccounts } from "./kubernetes/accounts";
import { purgeControllerFiles } from "./kubernetes/purge-files";
import { loadManagerPurgeConfig, loadPurgePhysicalStorage } from "./purge/config";
import { managerRecoveryCommand } from "./recovery/command";

const dataDir = process.env.POCKETCODER_MANAGER_DIR ?? "./manager_data";
const purgePath = process.env.POCKETCODER_MANAGER_PURGE_CONFIG;
if (process.argv[2] !== "operator" && !purgePath)
  throw new Error("Provide POCKETCODER_MANAGER_PURGE_CONFIG outside the manager data folder.");
const backups = process.env.POCKETCODER_MANAGER_OFF_NODE_CONFIG
  ? await loadManagerBackupConfig(process.env.POCKETCODER_MANAGER_OFF_NODE_CONFIG, dataDir)
  : undefined;
const purge = purgePath ? await loadManagerPurgeConfig(purgePath, dataDir, backups) : undefined;
const recoveryCommand = await managerRecoveryCommand(process.argv.slice(2), dataDir, purge, backups);
if (recoveryCommand) process.exit(0);
const store = await ManagerStore.create(dataDir, purge);
if (process.argv[2] === "operator") {
  try {
    const expiry = process.argv[3];
    if (!expiry) throw new Error("Provide an explicit ISO operator expiry, at most 24 hours");
    console.log(JSON.stringify({ token: await store.createOperator(new Date(expiry)), expires_at: expiry }));
  } finally {
    await store.close();
  }
} else {
  const config = ManagerConfigSchema.parse({
    controllerImage: process.env.POCKETCODER_MANAGER_CONTROLLER_IMAGE,
    runtimeClassName: process.env.POCKETCODER_MANAGER_RUNTIME_CLASS,
    purgeAuthority: true,
    ...(backups ? { offNodeBackups: true } : {}),
    ...(process.env.POCKETCODER_MANAGER_STORAGE_CLASS
      ? { storageClassName: process.env.POCKETCODER_MANAGER_STORAGE_CLASS }
      : {}),
    ...(process.env.POCKETCODER_MANAGER_PUBLIC_HOSTS
      ? { publicHosts: JSON.parse(process.env.POCKETCODER_MANAGER_PUBLIC_HOSTS) }
      : {}),
  });
  if (!purge) throw new Error("Private purge authority is required.");
  const physical = await loadPurgePhysicalStorage(purge, dataDir);
  const service = accountService(
    store,
    new KubernetesAccounts(undefined, backups, purgeControllerFiles(purge)),
    physical,
  );
  const usage = usageSampler(store);
  const app = createManagerApp(store, config, service);
  const endpoint = new URL(`http://${process.env.POCKETCODER_MANAGER_HTTP ?? "127.0.0.1:8092"}`);
  const server = Bun.serve({
    hostname: endpoint.hostname,
    port: Number(endpoint.port),
    maxRequestBodySize: 8192,
    fetch: app.fetch,
  });
  const timer = setInterval(() => {
    void service.reconcile().catch(() => console.error("Manager reconciliation failed"));
  }, 2000);
  void service.reconcile().catch(() => console.error("Manager reconciliation failed"));
  const usageTimer = setInterval(() => {
    void usage.sample().catch(() => console.error("Manager usage sampling failed"));
  }, 60_000);
  void usage.sample().catch(() => console.error("Manager usage sampling failed"));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    clearInterval(usageTimer);
    await server.stop(true);
    await Promise.all([service.close(), usage.close()]);
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
  console.log(`Manager listening at ${server.url}`);
}
