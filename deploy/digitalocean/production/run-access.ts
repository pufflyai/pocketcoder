import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ObjectStorage, readPrivateFile } from "@pstdio/pocketcoder-db/off-node";
import { loadManagerBackupConfig } from "@pstdio/pocketcoder-manager/backup";
import { loadManagerPurgeConfig } from "@pstdio/pocketcoder-manager/purge";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { z } from "zod";
import { issueOperators } from "./operators";
import { assertImmutableStorage, initializeStorage } from "./storage-contract";

const directory = "/etc/pocketcoder-private";
const credential = z
  .strictObject({ token: z.string().min(1), expiresAt: z.iso.datetime(), clusterId: z.uuid() })
  .parse(JSON.parse((await readPrivateFile(join(directory, "cloud-credential.json"), 65_536)).toString()));
const authorityExpiry = Date.parse(credential.expiresAt);
if (authorityExpiry <= Date.now()) throw new Error("Deployment cloud authority has expired.");
const [command] = process.argv.slice(2);
async function waitForManager() {
  const token = (await readPrivateFile(join(directory, "schedule-operator-token"), 4096)).toString().trim();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8092/v1/accounts", {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // systemd starts the process before its listener and database are ready.
    }
    await Bun.sleep(500);
  }
  throw new Error("Manager did not become ready within thirty seconds.");
}
if (command === "refresh") {
  const response = await fetch(
    `https://api.digitalocean.com/v2/kubernetes/clusters/${credential.clusterId}/kubeconfig?expiry_seconds=1800`,
    {
      headers: { authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error(`Kubernetes credential refresh failed: HTTP ${response.status}`);
  const path = join(directory, "kubeconfig");
  await writeFile(`${path}.new`, await response.text(), { mode: 0o600 });
  await rename(`${path}.new`, path);
} else if (command === "rotate") {
  const dataDir = process.env.POCKETCODER_MANAGER_DIR;
  const backupPath = process.env.POCKETCODER_MANAGER_OFF_NODE_CONFIG;
  const purgePath = process.env.POCKETCODER_MANAGER_PURGE_CONFIG;
  if (!dataDir || !backupPath || !purgePath) throw new Error("Provide private manager deployment paths.");
  const backups = await loadManagerBackupConfig(backupPath, dataDir);
  const purge = await loadManagerPurgeConfig(purgePath, dataDir, backups);
  const store = await ManagerStore.create(dataDir, purge);
  try {
    await issueOperators(store, directory, new Date(Math.min(authorityExpiry, Date.now() + 20 * 3600_000)));
  } finally {
    await store.close();
  }
} else if (command === "init-storage" || command === "storage-check") {
  const path = process.env.POCKETCODER_MANAGER_OFF_NODE_CONFIG;
  const dataDir = process.env.POCKETCODER_MANAGER_DIR;
  if (!path || !dataDir) throw new Error("Provide private manager backup paths.");
  const storage = new ObjectStorage((await loadManagerBackupConfig(path, dataDir)).storage);
  if (command === "init-storage") {
    await initializeStorage(storage);
  } else {
    await assertImmutableStorage(storage);
  }
} else if (command === "wait") {
  await waitForManager();
} else if (command === "ready") {
  await waitForManager();
  const metadata = await fetch("http://169.254.169.254/metadata/v1/id", { signal: AbortSignal.timeout(5000) });
  if (!metadata.ok) throw new Error("Operator host identity is unavailable.");
  const hostId = z
    .string()
    .regex(/^\d+$/)
    .parse((await metadata.text()).trim());
  const commit = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(process.env.POCKETCODER_OPERATOR_COMMIT);
  const sha256 = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(process.env.POCKETCODER_OPERATOR_SHA256);
  const bootId = z.uuid().parse((await Bun.file("/proc/sys/kernel/random/boot_id").text()).trim());
  const readyAt = new Date().toISOString();
  const child = Bun.spawn(["kubectl", "--kubeconfig", join(directory, "kubeconfig"), "apply", "-f", "-"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(
    JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "pc103-operator-ready", namespace: "kube-system" },
      data: { hostId, commit, sha256, bootId, readyAt },
    }),
  );
  child.stdin.end();
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (await child.exited) throw new Error("Operator readiness publication failed.");
} else {
  throw new Error("Usage: run-access.js <refresh|rotate|storage-check|wait|ready>");
}
console.log("Private deployment access renewed.");
