import { ObjectStorageError } from "@pstdio/pocketcoder-db/off-node";
import { waitFor } from "./local-process";
import { holdPurgeVolume, type PurgeFaultNode, pausePurgeNode } from "./managed-purge-faults";
import type { managedPurgeFixture } from "./managed-purge-fixture";

export async function exercisePurgeFaults(
  fixture: Awaited<ReturnType<typeof managedPurgeFixture>>,
  accountId: string,
  operationId: string,
  node: PurgeFaultNode,
  path: string,
) {
  async function pending(stage: string) {
    const response = await fixture.request(`/v1/operations/${operationId}`);
    const operation = (await response.json()) as { id: string; state: string };
    if (!response.ok || operation.id !== operationId || operation.state !== "pending")
      throw new Error(`Purge completed without ${stage} proof.`);
    console.log(JSON.stringify({ purgeFaultPending: { accountId, operationId, stage } }));
  }
  const offline = await pausePurgeNode(fixture.cluster, node);
  try {
    await fixture.reconcile();
    await pending("offline node");
    await fixture.stopManager();
    await fixture.openManager();
    await fixture.reconcile();
    await pending("offline node after manager restart");
  } finally {
    await offline.restore();
  }
  const held = await holdPurgeVolume(fixture.cluster, node, path);
  try {
    await waitFor(
      async () => {
        await fixture.reconcile();
        try {
          const retained = await fixture.storage.storage.storage.get(
            `manager/purge/accounts/${accountId}/inventory-${accountId}.json`,
          );
          await retained.body?.cancel();
          return fixture
            .physicalFailures()
            .some((refusal) => refusal.busy && JSON.parse(refusal.volumeId).path === path);
        } catch (error) {
          if (error instanceof ObjectStorageError && error.status === 404) return false;
          throw error;
        }
      },
      120_000,
      "actual retained inventory and busy physical deletion",
    );
    await pending("blocked physical deletion");
    const retained = await fixture.storage.storage.storage.get(
      `manager/purge/accounts/${accountId}/inventory-${accountId}.json`,
    );
    await retained.body?.cancel();
    await fixture.cluster.run(["docker", "exec", node.containerId, "test", "-d", path]);
    await fixture.stopManager();
    await fixture.openManager();
    await fixture.reconcile();
    await pending("blocked physical deletion after manager restart");
  } finally {
    await held.release();
  }
}
