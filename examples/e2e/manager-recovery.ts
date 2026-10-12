import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadManagerPurgeConfig } from "@pstdio/pocketcoder-manager/purge";
import {
  captureManagerBackup,
  completeManagerRecovery,
  restoreManagerBackup,
} from "@pstdio/pocketcoder-manager/recovery";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { waitFor } from "./local-process";
import { managedPurgeFixture } from "./managed-purge-fixture";

const fixture = await managedPurgeFixture({ physicalStorage: true });
let failure: unknown;
let cleanupFailure: unknown;
try {
  async function create(name: string) {
    const requestId = randomUUID();
    const response = await fixture.request("/v1/accounts", {
      method: "POST",
      headers: { "idempotency-key": requestId },
      body: JSON.stringify({ name }),
    });
    if (response.status !== 202) throw new Error("Manager recovery fixture could not create an account.");
    const result = (await response.json()) as { account: { id: string; namespace: string }; operation: { id: string } };
    return { ...result, requestId, name };
  }
  const deleted = await create("deleted recovery fixture");
  const survivor = await create("surviving recovery fixture");
  await fixture.reconcile();
  async function identities(namespace: string) {
    const deployment = JSON.parse(
      await fixture.cluster.kube(["-n", namespace, "get", "deployment", "controller", "-o", "json"]),
    );
    const volume = JSON.parse(
      await fixture.cluster.kube(["-n", namespace, "get", "pvc", "controller-data", "-o", "json"]),
    );
    return { deployment: deployment.metadata.uid as string, volume: volume.metadata.uid as string };
  }
  const before = await identities(survivor.account.namespace);
  await fixture.stopManager();
  const purge = await loadManagerPurgeConfig(fixture.purgeConfig, fixture.directory);
  const capture = {
    dataDir: fixture.directory,
    purge,
    encryptionKeyFile: join(fixture.cluster.directory, "off-node-master-key"),
    operationId: randomUUID(),
  };
  const receipt = await captureManagerBackup(capture);
  await fixture.openManager();
  const response = await fixture.request(`/v1/accounts/${deleted.account.id}/purge`, {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
  });
  if (response.status !== 202) throw new Error("Real account purge admission failed.");
  const purged = (await response.json()) as { operation: { id: string } };
  await waitFor(
    async () => {
      await fixture.reconcile();
      const operation = (await (await fixture.request(`/v1/operations/${purged.operation.id}`)).json()) as {
        state: string;
      };
      return operation.state === "succeeded";
    },
    120_000,
    "real account purge before manager restore",
  );
  await fixture.stopManager();
  const restore = {
    ...capture,
    dataDir: join(fixture.cluster.directory, "restored-manager"),
    operationId: randomUUID(),
    receipt,
  };
  await restoreManagerBackup(restore);
  let fenced = false;
  try {
    await ManagerStore.create(restore.dataDir, purge);
  } catch {
    fenced = true;
  }
  if (!fenced) throw new Error("Restored manager opened before deletion replay.");
  await completeManagerRecovery(restore);
  await fixture.openManager(restore.dataDir);
  await fixture.reconcile();
  const accounts = (await (await fixture.request("/v1/accounts")).json()) as { items: { id: string }[] };
  if (accounts.items.length !== 1 || accounts.items[0]?.id !== survivor.account.id)
    throw new Error("Manager recovery restored a deleted account or lost the survivor.");
  const replay = await fixture.request("/v1/accounts", {
    method: "POST",
    headers: { "idempotency-key": deleted.requestId },
    body: JSON.stringify({ name: deleted.name }),
  });
  if (replay.status !== 409) throw new Error("Deleted create identity was admitted after manager recovery.");
  if (JSON.stringify(before) !== JSON.stringify(await identities(survivor.account.namespace)))
    throw new Error("Manager recovery duplicated surviving provider resources.");
  if (await fixture.cluster.kube(["get", "namespace", deleted.account.namespace, "--ignore-not-found", "-o", "json"]))
    throw new Error("Manager recovery recreated the deleted namespace.");
  await fixture.stopManager();
  await fixture.openManager(restore.dataDir);
  await fixture.reconcile();
  if (JSON.stringify(before) !== JSON.stringify(await identities(survivor.account.namespace)))
    throw new Error("Manager restart duplicated surviving provider resources.");
  console.log(
    JSON.stringify({
      managerRecoveryPassed: {
        deletedAccount: deleted.account.id,
        survivingAccount: survivor.account.id,
        sourceWriterRetired: true,
        journalReplay: true,
        originalOperator: true,
        survivingResources: before,
        backupVersion: receipt.object.versionId,
      },
    }),
  );
} catch (error) {
  failure = error;
} finally {
  try {
    await fixture.close();
  } catch (cleanup) {
    cleanupFailure = cleanup;
  }
}
if (cleanupFailure)
  throw new AggregateError([...(failure ? [failure] : []), cleanupFailure], "Manager recovery fixture cleanup failed");
if (failure) throw failure;
