import { accountService, createManagerApp } from "@pstdio/pocketcoder-manager";
import { loadManagerBackupConfig } from "@pstdio/pocketcoder-manager/backup";
import { KubernetesAccounts } from "@pstdio/pocketcoder-manager/kubernetes";
import { loadManagerPurgeConfig } from "@pstdio/pocketcoder-manager/purge";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";

export type PurgeBootstrapChildInput = {
  directory: string;
  controllerImage: string;
  backupConfig: string;
  purgeConfig: string;
};

const input: PurgeBootstrapChildInput = await Bun.file(process.argv[2] as string).json();
const purge = await loadManagerPurgeConfig(input.purgeConfig, input.directory);
const store = await ManagerStore.create(input.directory, purge);
const backups = await loadManagerBackupConfig(input.backupConfig, input.directory);
const service = accountService(store, new KubernetesAccounts(undefined, backups));
const app = createManagerApp(
  store,
  { controllerImage: input.controllerImage, runtimeClassName: "pc-runc", offNodeBackups: true },
  service,
);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 8192, fetch: app.fetch });
const emit = (value: unknown) => console.log(`PURGE_BOOTSTRAP_CHILD ${JSON.stringify(value)}`);
emit({ ready: server.url.toString(), pid: process.pid });

// Reconciliation starts only when the parent explicitly asks for it.
let pending = "";
try {
  for await (const bytes of Bun.stdin.stream()) {
    pending += new TextDecoder().decode(bytes);
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const command = JSON.parse(pending.slice(0, end)) as { id: number };
      pending = pending.slice(end + 1);
      try {
        await service.reconcile();
        emit({ id: command.id, complete: true });
      } catch (error) {
        emit({ id: command.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
} finally {
  await server.stop(true);
  await service.close();
  await store.close();
}
process.exit(0);
