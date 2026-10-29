import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AccountPurgeIntent, AccountPurgeIntentSchema } from "@pstdio/pocketcoder-contracts";
import { ObjectStorage, type ObjectStorageConfig } from "@pstdio/pocketcoder-db/off-node";
import { createRequestDigest, intentKeys, purgeRequestDigest } from "@pstdio/pocketcoder-manager/purge";
import type { PurgeBootstrapChildInput } from "./managed-purge-bootstrap-child";
import { purgeBootstrapChild } from "./managed-purge-bootstrap-debugger";

type Child = Awaited<ReturnType<typeof purgeBootstrapChild>>;
export type BootstrapKeyIdentity = Awaited<ReturnType<Child["ownerIdentity"]>> & { controllerUid: string };
type Manager = {
  request: (path: string, input?: RequestInit) => Promise<Response>;
  reconcile: () => Promise<void>;
};
type Input = PurgeBootstrapChildInput & {
  kubeconfig: string;
  operatorToken: string;
  accountId: string;
  namespace: string;
  createRequestId: string;
  bootstrapRequestId: string;
  purgeRequestId: string;
  expiresAt: string;
  storage: ObjectStorageConfig;
  mode: "live-authority" | "killed-api";
  controllerUid: () => Promise<string>;
  verifyCoreKey: (identity: BootstrapKeyIdentity, stage: "issued" | "revoked", manager: Manager) => Promise<void>;
};

// The fixture writes real immutable authority, outside the paused manager's database.
async function publishIntent(config: ObjectStorageConfig, intent: AccountPurgeIntent) {
  const storage = new ObjectStorage(config);
  const body = JSON.stringify(intent);
  const versions: { key: string; versionId: string }[] = [];
  for (const key of intentKeys(intent)) {
    const receipt = await storage.putIfAbsent(key, Buffer.from(body));
    const stored = AccountPurgeIntentSchema.parse(await (await storage.get(key, receipt.versionId)).json());
    if (JSON.stringify(stored) !== body) throw new Error("Exact purge authority version differs");
    versions.push({ key, versionId: receipt.versionId });
  }
  return versions;
}

async function bounded<T>(work: Promise<T>, milliseconds: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertKeyBinding(input: Input, identity: BootstrapKeyIdentity) {
  if (
    identity.accountId !== input.accountId ||
    identity.namespace !== input.namespace ||
    identity.requestId !== input.bootstrapRequestId ||
    identity.issuanceRequestId !== input.bootstrapRequestId ||
    identity.expiresAt !== input.expiresAt
  )
    throw new Error("Actual bootstrap key binding differs");
}

async function assertIntentBinding(input: Input, intent: AccountPurgeIntent) {
  if (
    intent.accountId !== input.accountId ||
    intent.createRequestDigest !== createRequestDigest(input.createRequestId) ||
    intent.purgeRequestDigest !== purgeRequestDigest(input.purgeRequestId)
  )
    throw new Error("Permanent purge intent request binding differs");
  const storage = new ObjectStorage(input.storage);
  for (const key of intentKeys(intent)) {
    const current = await storage.get(key);
    const versionId = current.headers.get("x-amz-version-id");
    await current.body?.cancel();
    if (!versionId || versionId === "null") throw new Error("Permanent purge index version is missing");
    const exact = AccountPurgeIntentSchema.parse(await (await storage.get(key, versionId)).json());
    if (JSON.stringify(exact) !== JSON.stringify(intent)) throw new Error("Permanent purge index identity differs");
  }
}

function assertResponseFenced(mode: Input["mode"], response: { status: number; code?: string; plaintext: boolean }) {
  if (response.plaintext) throw new Error("Interrupted owner response exposed plaintext");
  if (mode === "live-authority" && (response.status !== 409 || response.code !== "account_purged"))
    throw new Error("Live owner response was not fenced");
  if (mode === "killed-api" && response.status >= 200 && response.status < 300)
    throw new Error("Killed owner request succeeded");
}

async function assertPostFence(input: Input, manager: Manager, intent: AccountPurgeIntent) {
  for (const requestId of [input.bootstrapRequestId, randomUUID()]) {
    const retry = await manager.request(`/v1/accounts/${input.accountId}/owner`, {
      method: "POST",
      body: JSON.stringify({ request_id: requestId, expires_at: input.expiresAt }),
    });
    if (retry.status !== 409 || ((await retry.json()) as { code?: string }).code !== "account_purged")
      throw new Error("Owner issuance accepted after the permanent purge fence");
  }
  const retry = await manager.request(`/v1/accounts/${input.accountId}/purge`, {
    method: "POST",
    headers: { "idempotency-key": input.purgeRequestId },
  });
  if (
    retry.status !== 202 ||
    ((await retry.json()) as { operation: { id: string } }).operation.id !== intent.operationId
  )
    throw new Error("Purge retry changed its durable operation");
}

// The caller owns the single cluster and closes its manager before handing over this folder.
export async function managedPurgeBootstrap(input: Input) {
  const scratch = await mkdtemp(join(dirname(input.directory), "purge-bootstrap-"));
  await chmod(scratch, 0o700);
  const config = join(scratch, "child.json");
  await writeFile(
    config,
    JSON.stringify({
      directory: input.directory,
      controllerImage: input.controllerImage,
      backupConfig: input.backupConfig,
      purgeConfig: input.purgeConfig,
    } satisfies PurgeBootstrapChildInput),
    { mode: 0o600 },
  );
  let child: Child | undefined;
  const request = (path: string, init: RequestInit = {}) => {
    if (!child) throw new Error("Bootstrap manager child is not running");
    return fetch(new URL(path, child.url), {
      ...init,
      headers: { authorization: `Bearer ${input.operatorToken}`, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(130_000),
    });
  };
  const manager: Manager = {
    request,
    reconcile() {
      if (!child) throw new Error("Bootstrap manager child is not running");
      return child.reconcile();
    },
  };
  const ownerInput = { request_id: input.bootstrapRequestId, expires_at: input.expiresAt };
  const owner = () =>
    request(`/v1/accounts/${input.accountId}/owner`, { method: "POST", body: JSON.stringify(ownerInput) });
  const admission = () =>
    request(`/v1/accounts/${input.accountId}/purge`, {
      method: "POST",
      headers: { "idempotency-key": input.purgeRequestId },
    });
  let failure: unknown;
  let result: { identity: BootstrapKeyIdentity; intent: AccountPurgeIntent } | undefined;
  const cleanupErrors: unknown[] = [];
  try {
    child = await purgeBootstrapChild(config, input.kubeconfig);
    const controllerUid = AccountPurgeIntentSchema.shape.accountId.parse(await input.controllerUid());
    const paused = await child.arm(
      "/accounts/service.ts",
      "const result = await provider.owner(account, request);",
      "await store.completeBootstrap(",
    );
    const pending = owner().then(
      async (response) => {
        const value = (await response.json()) as { code?: string; token?: unknown };
        return { status: response.status, code: value.code, plaintext: typeof value.token === "string" };
      },
      () => ({ status: 0, code: "connection_closed", plaintext: false }),
    );
    await Promise.race([
      paused(120_000),
      pending.then(() => {
        throw new Error("Owner response escaped before the armed boundary");
      }),
    ]);
    const identity: BootstrapKeyIdentity = { ...(await child.ownerIdentity()), controllerUid };
    assertKeyBinding(input, identity);
    await input.verifyCoreKey(identity, "issued", manager);
    let intent: AccountPurgeIntent;
    if (input.mode === "live-authority") {
      intent = AccountPurgeIntentSchema.parse({
        format: "pocketcoder-account-purge/v1",
        accountId: input.accountId,
        operationId: randomUUID(),
        createRequestDigest: createRequestDigest(input.createRequestId),
        purgeRequestDigest: purgeRequestDigest(input.purgeRequestId),
        admittedAt: new Date().toISOString(),
      });
      const versions = await publishIntent(input.storage, intent);
      console.log(
        JSON.stringify({
          bootstrapAuthorityArrival: input.mode,
          accountId: input.accountId,
          operationId: intent.operationId,
          versions,
        }),
      );
      await child.resume();
    } else {
      await child.kill();
      child = undefined;
      child = await purgeBootstrapChild(config, input.kubeconfig);
      const admitted = await admission();
      if (admitted.status !== 202) throw new Error(`Post-crash purge admission refused (${admitted.status})`);
      const { operation } = (await admitted.json()) as { operation: { id: string; account_id: string } };
      intent = AccountPurgeIntentSchema.parse(
        await (
          await new ObjectStorage(input.storage).get(`manager/purge/accounts/${input.accountId}/intent.json`)
        ).json(),
      );
      if (operation.id !== intent.operationId || operation.account_id !== input.accountId)
        throw new Error("Actual purge admission identity differs");
    }
    await assertIntentBinding(input, intent);
    const response = await bounded(pending, 10_000, "interrupted owner response");
    console.log(
      JSON.stringify({
        bootstrapResponse: input.mode,
        accountId: input.accountId,
        controllerUid,
        keyId: identity.keyId,
        status: response.status,
        code: response.code,
        plaintextPresent: response.plaintext,
      }),
    );
    assertResponseFenced(input.mode, response);
    await assertPostFence(input, manager, intent);
    if ((await input.controllerUid()) !== controllerUid)
      throw new Error("Bootstrap controller UID changed before revocation proof");
    await input.verifyCoreKey(identity, "revoked", manager);
    console.log(
      JSON.stringify({
        bootstrapPurge: "passed",
        mode: input.mode,
        accountId: identity.accountId,
        controllerUid,
        keyId: identity.keyId,
        operationId: intent.operationId,
        plaintextPresentAtPause: true,
        latePlaintext: false,
        postFenceOwner: "refused",
        coreKey: "revoked before physical cleanup",
      }),
    );
    result = { identity, intent };
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = await Promise.allSettled([child?.close()]);
    cleanup.push(...(await Promise.allSettled([rm(scratch, { recursive: true, force: true })])));
    cleanupErrors.push(...cleanup.flatMap((entry) => (entry.status === "rejected" ? [entry.reason] : [])));
  }
  if (cleanupErrors.length)
    throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], "Bootstrap child cleanup failed");
  if (failure) throw failure;
  if (!result) throw new Error("Bootstrap boundary result is missing");
  return result;
}
