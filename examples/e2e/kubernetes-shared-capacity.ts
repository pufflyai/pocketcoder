import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { PersistenceMount } from "@pstdio/pocketcoder-contracts";
import type { KubernetesSharedStorage } from "@pstdio/pocketcoder-drivers";

export async function measureSharedCapacity(storage: KubernetesSharedStorage, mounts: PersistenceMount[]) {
  const concurrency = [];
  for (const attempts of [1, 5, 20]) {
    const started = performance.now();
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () =>
        storage.allocate({
          storageId: randomUUID(),
          workspaceId: randomUUID(),
          uid: 10001,
          gid: 10001,
          mounts,
        }),
      ),
    );
    const admitted = results.filter((result) => result.status === "fulfilled");
    assert.equal(admitted.length, Math.min(attempts, 4));
    concurrency.push({
      attempts,
      admitted: admitted.length,
      rejected: attempts - admitted.length,
      durationMs: Math.round(performance.now() - started),
    });
    for (const result of admitted) await storage.deleteStorage(result.value.ref);
  }
  console.log(JSON.stringify({ storageConcurrency: concurrency }));
}
