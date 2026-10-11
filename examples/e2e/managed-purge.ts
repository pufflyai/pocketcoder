import { randomUUID } from "node:crypto";
import { type BootstrapKeyIdentity, managedPurgeBootstrap } from "./managed-purge-bootstrap";
import { managedPurgeFixture } from "./managed-purge-fixture";

const fixture = await managedPurgeFixture();
let failure: unknown;
let cleanupFailure: unknown;
try {
  const createRequestId = randomUUID();
  const created = await fixture.request("/v1/accounts", {
    method: "POST",
    headers: { "idempotency-key": createRequestId },
    body: JSON.stringify({ name: "purge-bootstrap" }),
  });
  if (created.status !== 202) throw new Error(`Account admission failed: ${created.status}`);
  const { account, operation } = (await created.json()) as {
    account: { id: string; namespace: string };
    operation: { id: string };
  };
  await fixture.reconcile();
  const provision = await fixture.request(`/v1/operations/${operation.id}`);
  const provisioned = (await provision.json()) as { state: string; errorCode?: string };
  if (provisioned.state !== "succeeded") {
    console.log(JSON.stringify({ provisioning: provisioned }));
    for (const args of [
      ["get", "pods", "-o", "wide"],
      ["get", "events", "--sort-by=.lastTimestamp"],
      ["logs", "deployment/controller", "-c", "controller", "--tail=25"],
      ["logs", "deployment/controller", "-c", "private-storage", "--tail=25"],
    ]) {
      try {
        console.error(await fixture.cluster.kube(["-n", account.namespace, ...args]));
      } catch (error) {
        console.error(String(error));
      }
    }
    throw new Error("Account provisioning remains pending");
  }
  const controller = async () => {
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
    ).items as { metadata: { name: string; uid: string } }[];
    if (pods.length !== 1 || !pods[0]) throw new Error("Expected one owned controller");
    return pods[0].metadata;
  };
  const privateRequest = async (path: string, body?: object) => {
    const pod = await controller();
    const script = `const r=await fetch(${JSON.stringify(`http://localhost${path}`)}, {
      unix:'/private/pc_data/admin.sock',
      ${body ? `method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(body))},` : ""}
    });console.log(JSON.stringify({status:r.status,body:await r.json()}));`;
    return JSON.parse(
      await fixture.cluster.kube([
        "-n",
        account.namespace,
        "exec",
        pod.name,
        "-c",
        "controller",
        "--",
        "bun",
        "-e",
        script,
      ]),
    ) as { status: number; body: unknown };
  };
  await fixture.stopManager();
  await managedPurgeBootstrap({
    directory: fixture.directory,
    controllerImage: fixture.controllerImage,
    backupConfig: fixture.backupConfig,
    purgeConfig: fixture.purgeConfig,
    kubeconfig: fixture.kubeconfig,
    operatorToken: fixture.operatorToken,
    accountId: account.id,
    namespace: account.namespace,
    createRequestId,
    bootstrapRequestId: randomUUID(),
    purgeRequestId: randomUUID(),
    expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    storage: fixture.storage.storage.config,
    mode: "live-authority",
    controllerUid: async () => (await controller()).uid,
    async verifyCoreKey(identity: BootstrapKeyIdentity, stage, manager) {
      if ((await controller()).uid !== identity.controllerUid) throw new Error("Controller changed before key proof");
      const route = `/v1/account/purge/keys/${identity.keyId}`;
      const response = await privateRequest(route);
      const value = response.body as {
        account_id: string;
        operation_id: string | null;
        key: { id: string; expires_at: string; revoked_at: string | null };
      };
      if (
        response.status !== 200 ||
        value.account_id !== account.id ||
        value.key.id !== identity.keyId ||
        value.key.expires_at !== identity.expiresAt
      )
        throw new Error("Actual private key row binding differs");
      if (stage === "issued") {
        if (value.operation_id !== null || value.key.revoked_at !== null)
          throw new Error("Expected an issued key before permanent authority arrival");
        return;
      }
      if (!value.operation_id) throw new Error("Private key proof has no admitted purge operation");
      const purge = await privateRequest("/v1/account/purge", { operation_id: value.operation_id });
      if (purge.status !== 200) throw new Error(`Actual core purge drain remains pending: ${purge.status}`);
      const revoked = await privateRequest(route);
      const row = revoked.body as typeof value;
      if (
        revoked.status !== 200 ||
        row.operation_id !== value.operation_id ||
        !row.key.revoked_at ||
        row.key.id !== identity.keyId ||
        (await controller()).uid !== identity.controllerUid
      )
        throw new Error("Actual owner key was not revoked in the original controller before physical cleanup");
      const retry = await manager.request(`/v1/accounts/${account.id}/owner`, {
        method: "POST",
        body: JSON.stringify({ request_id: randomUUID(), expires_at: identity.expiresAt }),
      });
      if (retry.status !== 409) throw new Error("Post-fence owner issuance accepted");
      console.log(
        JSON.stringify({
          privateKeyProof: stage,
          accountId: account.id,
          controllerUid: identity.controllerUid,
          keyId: row.key.id,
          revokedAt: row.key.revoked_at,
        }),
      );
    },
  });
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
  throw new AggregateError([...(failure ? [failure] : []), cleanupFailure], "Managed purge cleanup failed");
if (failure) throw failure;
