import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ApiError, digestOf } from "@pstdio/pocketcoder-contracts";
import type {
  ManagedRuntimeStore,
  ManagedSessionIdentity,
  WorkspaceLeasePurpose,
  WorkspaceLeaseRow,
  WorkspaceLeaseStore,
  WorkspaceStore,
} from "@pstdio/pocketcoder-runtime-core";
import { CredentialsRefused, type createIssuerClient } from "./issuer-client";
import type { createSecretVault } from "./secret-vault";

async function readManagedIssuer(
  managed: ManagedRuntimeStore | undefined,
  principalId: string,
  name: string,
  clusterLocalIssuers: boolean,
) {
  if (!managed) throw new ApiError("secret.unavailable", "Workspace issuer is unavailable.");
  const config = await managed.profiles.issuer(principalId, name);
  if (new URL(config.url).protocol === "http:" && !clusterLocalIssuers)
    throw new ApiError("secret.unavailable", "Workspace issuer is unavailable.");
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  if (!token) throw new ApiError("secret.unavailable", "Workspace issuer is unavailable.");
  return { ...config, authorization: `Bearer ${token}` };
}

type Vault = ReturnType<typeof createSecretVault>;
export function createWorkspaceLeaseService({
  store,
  vault,
  issuer,
  now = () => new Date(),
  admissionFenced = () => false,
  clusterLocalIssuers = false,
}: {
  store: WorkspaceLeaseStore & { managed?: ManagedRuntimeStore; getWorkspace?: WorkspaceStore["getWorkspace"] };
  vault?: Vault;
  issuer: ReturnType<typeof createIssuerClient>;
  now?: () => Date;
  admissionFenced?: () => boolean;
  clusterLocalIssuers?: boolean;
}) {
  const unavailable = () => new ApiError("secret.unavailable", "Workspace issuer is unavailable.");
  const revocations = new Map<string, Promise<void>>();
  const managedIssuer = (principalId: string, name: string) =>
    readManagedIssuer(store.managed, principalId, name, clusterLocalIssuers);
  async function configFor(row: WorkspaceLeaseRow) {
    const a = row.managedAuthority;
    if (a) return managedIssuer(a.principalId, a.issuer);
    if (!vault || !row.secretVersionId) throw unavailable();
    const config = await vault.resolveVersion(row.secretVersionId, row.purpose);
    if (config.type === "registry") throw unavailable();
    return { ...config.value, revoke: true };
  }
  async function deliver(config: Awaited<ReturnType<typeof configFor>>, row: WorkspaceLeaseRow) {
    if (
      admissionFenced() ||
      ["revoking", "revoked", "expired", "superseded"].includes(row.state) ||
      row.requestExpiresAt <= now() ||
      (await store.hasWorkspaceLeaseFence(row.workspaceId))
    )
      throw unavailable();
    let result: Awaited<ReturnType<typeof issuer.mint>>;
    try {
      result = await issuer.mint(config, row);
    } catch (error) {
      await store.supersedeWorkspaceLease(row.id, now());
      if (error instanceof CredentialsRefused && row.managedAuthority && store.managed) {
        await store.managed.requests.refuse(row.managedAuthority, now());
      }
      throw error;
    }
    const issued = await store.recordWorkspaceLeaseIssued(
      row.id,
      result.expiresAt,
      Buffer.byteLength(result.credential),
      now(),
    );
    const delivered =
      !admissionFenced() && issued?.state !== "revoking" && (await store.recordWorkspaceLeaseDelivered(row.id, now()));
    if (!delivered || admissionFenced()) {
      await store.supersedeWorkspaceLease(row.id, now());
      if (config.revoke && (await store.hasWorkspaceLeaseFence(row.workspaceId))) await revoke(row.id).catch(() => {});
      throw unavailable();
    }
    return { lease: delivered, credential: result.credential };
  }
  async function notifyRevocation(config: Awaited<ReturnType<typeof configFor>>, row: WorkspaceLeaseRow) {
    if (!config.revoke || row.revokeAcknowledgedAt) return row;
    const a = row.managedAuthority,
      key = a ? `${a.principalId}:${a.sessionId}:${a.generation}:${a.issuer}` : row.id;
    let pending = revocations.get(key);
    if (!pending) {
      pending = issuer.revoke(config, row).then(() => store.acknowledgeLeaseRevocation(row.id, now()));
      revocations.set(key, pending);
    }
    try {
      await pending;
    } finally {
      revocations.delete(key);
    }
    return (await store.getWorkspaceLease(row.id)) ?? row;
  }
  async function revoke(id: string) {
    let row = await store.requestWorkspaceLeaseRevocation(id, now());
    if (["revoked", "expired"].includes(row.state)) return;
    const config = await configFor(row);
    row = await notifyRevocation(config, row);
    const workspace = await store.getWorkspace?.(row.workspaceId);
    const removed = row.removedAt || workspace?.terminalAt || workspace?.runtimeRegistration?.endedAt;
    // A setup credential is no longer used after the issuer acknowledges its revoke.
    if ((row.managedAuthority ? removed : config.revoke) && (!config.revoke || row.revokeAcknowledgedAt))
      await store.recordWorkspaceLeaseRevoked(id, row.requestId, now());
    else await store.recordWorkspaceLeaseExpired(id, now());
  }
  async function issue(workspaceId: string, name: string, purpose: WorkspaceLeasePurpose, _requestId = randomUUID()) {
    if (!vault || admissionFenced()) throw unavailable();
    const config = await vault.resolve(name, purpose);
    if (config.type === "registry") throw unavailable();
    const row = await store.requestWorkspaceLease({
      workspaceId,
      secretName: name,
      secretVersionId: config.id,
      purpose,
      policyDigest: digestOf(config.value.policy),
      requestId: randomUUID(),
      at: now(),
    });
    return deliver({ ...config.value, revoke: true }, row);
  }
  async function issueManaged(
    identity: ManagedSessionIdentity,
    workspaceId: string,
    generation: number,
    slot: string,
    _requestId = randomUUID(),
  ) {
    if (!store.managed || admissionFenced()) throw unavailable();
    const bound = await store.managed.profiles.leaseAuthority(identity, workspaceId, generation, slot);
    const config = await managedIssuer(identity.principalId, bound.authority.issuer);
    const row = await store.requestWorkspaceLease({
      workspaceId,
      secretName: bound.authority.issuer,
      secretVersionId: null,
      purpose: "runtime-issuer",
      policyDigest: digestOf(config.policy),
      requestId: randomUUID(),
      at: now(),
      managedAuthority: bound.authority,
    });
    return deliver(config, row);
  }
  async function fresh(previous: WorkspaceLeaseRow, supersede = true) {
    if (supersede) await store.supersedeWorkspaceLease(previous.id, now());
    const a = previous.managedAuthority;
    return a
      ? issueManaged({ principalId: a.principalId, sessionId: a.sessionId }, previous.workspaceId, a.generation, a.slot)
      : issue(previous.workspaceId, previous.secretName, previous.purpose);
  }
  async function revokeAll(rows: WorkspaceLeaseRow[]) {
    let failed = false;
    for (const row of rows) {
      try {
        await revoke(row.id);
      } catch {
        failed = true;
      }
    }
    if (failed) throw unavailable();
  }
  return {
    issue,
    issueManaged,
    revoke,
    discard: (id: string) => store.supersedeWorkspaceLease(id, now()),
    async expire(id: string) {
      const row = await store.getWorkspaceLease(id);
      if (!row) return;
      if (!row.managedAuthority) {
        await store.recordWorkspaceLeaseExpired(id, now());
        return;
      }
      const config = await configFor(row);
      // An ordinary renewal must never send a generation-wide revoke. Keep the optional
      // notice obligation until the generation ends, even after this credential expires.
      if (config.revoke) await store.supersedeWorkspaceLease(id, now());
      else await store.recordWorkspaceLeaseExpired(id, now());
    },
    async replay(workspaceId: string, leaseId: string) {
      const row = await store.getWorkspaceLease(leaseId);
      if (
        !row ||
        row.workspaceId !== workspaceId ||
        ["revoking", "revoked", "expired", "superseded"].includes(row.state)
      )
        throw unavailable();
      return fresh(row);
    },
    async renew(workspaceId: string, previousLeaseId: string, _requestId: string) {
      const previous = await store.getWorkspaceLease(previousLeaseId);
      if (!previous || previous.workspaceId !== workspaceId || previous.purpose !== "runtime-issuer")
        throw unavailable();
      for (const row of await store.listPendingWorkspaceLeases(workspaceId)) {
        if (
          row.id !== previous.id &&
          row.secretName === previous.secretName &&
          row.managedAuthority?.sessionId === previous.managedAuthority?.sessionId &&
          row.managedAuthority?.slot === previous.managedAuthority?.slot
        )
          await store.supersedeWorkspaceLease(row.id, now());
      }
      return fresh(previous, false);
    },
    async completeRenewal(workspaceId: string, previousLeaseId: string, leaseId: string) {
      const previous = await store.getWorkspaceLease(previousLeaseId),
        installed = await store.getWorkspaceLease(leaseId);
      if (
        !previous ||
        !installed ||
        previous.id === installed.id ||
        installed.workspaceId !== workspaceId ||
        previous.workspaceId !== workspaceId ||
        installed.state !== "delivered" ||
        previous.secretName !== installed.secretName
      )
        throw unavailable();
      // The resource lets the old credential expire. No per-credential revoke is needed.
      await store.supersedeWorkspaceLease(previous.id, now());
    },
    async completeSetup(workspaceId: string) {
      await revokeAll(
        (await store.listPendingWorkspaceLeases(workspaceId)).filter((r) => r.purpose === "setup-issuer"),
      );
    },
    async revokeWorkspace(workspaceId: string) {
      await store.fenceWorkspaceLeases(workspaceId, now());
      await revokeAll(await store.listPendingWorkspaceLeases(workspaceId));
    },
    async revokeSession(workspaceId: string, sessionId: string) {
      await revokeAll(
        (await store.listPendingWorkspaceLeases(workspaceId)).filter(
          (r) => r.managedAuthority?.sessionId === sessionId,
        ),
      );
    },
    async removed(workspaceId: string, sessionId: string) {
      await store.acknowledgeSessionLeaseRemoval(workspaceId, sessionId, now());
      await revokeAll(
        (await store.listPendingWorkspaceLeases(workspaceId)).filter(
          (r) => r.managedAuthority?.sessionId === sessionId,
        ),
      );
    },
  };
}
