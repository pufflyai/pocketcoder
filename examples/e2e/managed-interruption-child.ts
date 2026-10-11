import { accountService, createManagerApp } from "@pstdio/pocketcoder-manager";
import { loadManagerBackupConfig } from "@pstdio/pocketcoder-manager/backup";
import { KubernetesAccounts } from "@pstdio/pocketcoder-manager/kubernetes";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";

export type ManagerChildInput = {
  directory: string;
  controllerImage: string;
  backupConfig: string;
};

const input: ManagerChildInput = await Bun.file(process.argv[2] as string).json();
const store = await ManagerStore.create(input.directory);
const backups = await loadManagerBackupConfig(input.backupConfig, input.directory);
const service = accountService(store, new KubernetesAccounts(undefined, backups));
const app = createManagerApp(
  store,
  { controllerImage: input.controllerImage, runtimeClassName: "pc-runc", offNodeBackups: true },
  service,
);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 8192, fetch: app.fetch });
const emit = (value: unknown) => console.log(`MANAGER_CHILD ${JSON.stringify(value)}`);
emit({ ready: server.url.toString(), pid: process.pid });

// The parent drives the real reconciler. No timer can advance a crash boundary before it is armed.
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
