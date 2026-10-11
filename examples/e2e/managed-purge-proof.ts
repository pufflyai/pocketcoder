import { ObjectStorageError } from "@pstdio/pocketcoder-db/off-node";
import type { managedPurgeFixture } from "./managed-purge-fixture";

export async function verifyManagedPurgeDrain(
  fixture: Awaited<ReturnType<typeof managedPurgeFixture>>,
  account: { id: string; namespace: string },
  operationId: string,
  issued: { keyId: string; controllerUid: string },
) {
  try {
    await (
      await fixture.storage.storage.storage.get(`manager/purge/accounts/${account.id}/drained-${account.id}.json`)
    ).body?.cancel();
  } catch (error) {
    if (error instanceof ObjectStorageError && error.status === 404) return false;
    throw error;
  }
  const pods = JSON.parse(
    await fixture.cluster.kube([
      "-n",
      account.namespace,
      "get",
      "pods",
      "-l",
      "pocketcoder.dev/role=controller",
      "-o",
      "json",
    ]),
  ).items;
  if (pods.length !== 1 || pods[0].metadata.uid !== issued.controllerUid)
    throw new Error("Controller changed before real key revocation proof.");
  const script =
    "const path=JSON.parse(process.argv[1]);const r=await fetch('http://localhost'+path,{unix:'/private/pc_data/admin.sock',signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({status:r.status,body:await r.json()}))";
  const response = JSON.parse(
    await fixture.cluster.kube([
      "-n",
      account.namespace,
      "exec",
      pods[0].metadata.name,
      "-c",
      "controller",
      "--",
      "bun",
      "-e",
      script,
      JSON.stringify(`/v1/account/purge/keys/${issued.keyId}`),
    ]),
  );
  const row = response.body;
  if (
    response.status !== 200 ||
    row.account_id !== account.id ||
    row.operation_id !== operationId ||
    row.key.id !== issued.keyId ||
    !row.key.revoked_at
  )
    throw new Error("Actual original controller key row is not revoked.");
  console.log(
    JSON.stringify({
      actualPurgeKeyRevoked: {
        accountId: account.id,
        operationId,
        controllerUid: issued.controllerUid,
        keyId: row.key.id,
        revokedAt: row.key.revoked_at,
      },
    }),
  );
  return true;
}
