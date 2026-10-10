import { randomUUID } from "node:crypto";
import { type ProviderInput, runtimeCredentialReferences } from "@pstdio/pocketcoder-contracts";
import type { RuntimeMountRef, StorageRef } from "../driver";

import type { ActiveCounts, WorkspaceRow } from "../types";

import { cleanupUncommittedProvider } from "./provider-termination";
import type { SchedulerContext } from "./scheduler-base";

export class SchedulerAdmission {
  constructor(private readonly context: SchedulerContext) {}
  groupQueuedByPrincipal(queued: WorkspaceRow[]): Map<string, WorkspaceRow[]> {
    const byPrincipal = new Map<string, WorkspaceRow[]>();
    for (const row of queued) {
      const list = byPrincipal.get(row.principalId) ?? [];
      list.push(row);
      byPrincipal.set(row.principalId, list);
    }
    return byPrincipal;
  }

  principalRotation(byPrincipal: Map<string, WorkspaceRow[]>): string[] {
    const principals = [...byPrincipal.keys()];
    const startIndex = this.context.lastAdmittedPrincipal
      ? (principals.indexOf(this.context.lastAdmittedPrincipal) + 1) % principals.length
      : 0;
    return [...principals.slice(startIndex), ...principals.slice(0, startIndex)];
  }

  canAdmit(row: WorkspaceRow, counts: ActiveCounts): boolean {
    const { limits } = this.context.deps;
    const principalActive = counts.byPrincipal[row.principalId] ?? 0;
    if (principalActive >= limits.perPrincipalActiveWorkspaces) return false;
    const templateLimit = limits.perTemplateActiveWorkspaces[row.templateName] ?? limits.globalActiveWorkspaces;
    return (counts.byTemplate[row.templateName] ?? 0) < templateLimit;
  }

  recordAdmission(row: WorkspaceRow, counts: ActiveCounts): void {
    counts.global += 1;
    counts.byPrincipal[row.principalId] = (counts.byPrincipal[row.principalId] ?? 0) + 1;
    counts.byTemplate[row.templateName] = (counts.byTemplate[row.templateName] ?? 0) + 1;
    this.context.lastAdmittedPrincipal = row.principalId;
  }

  async admitRound(
    byPrincipal: Map<string, WorkspaceRow[]>,
    rotation: string[],
    counts: ActiveCounts,
  ): Promise<boolean> {
    let progressed = false;
    for (const principalId of rotation) {
      if (counts.global >= this.context.deps.limits.globalActiveWorkspaces) break;
      const list = byPrincipal.get(principalId);
      const row = list?.[0];
      if (!row || !this.canAdmit(row, counts)) continue;
      list?.shift();
      this.context.deps.metrics?.increment("admission.total", { result: "attempted" });
      if (await this.launch(row)) {
        this.recordAdmission(row, counts);
        this.context.deps.metrics?.increment("admission.total", { result: "accepted" });
        this.context.deps.metrics?.observe(
          "workspace.queue_delay_ms",
          Math.max(0, this.context.now().getTime() - row.createdAt.getTime()),
          { template: row.templateName },
        );
        progressed = true;
      } else {
        this.context.deps.metrics?.increment("admission.total", { result: "deferred" });
      }
    }
    return progressed;
  }

  async admit(): Promise<void> {
    const { store, limits } = this.context.deps;
    while (true) {
      let snapshot: Awaited<ReturnType<typeof store.readAdmissionSnapshot>>;
      try {
        snapshot = await store.readAdmissionSnapshot();
      } catch (err) {
        this.context.report("admit.snapshot", err);
        return;
      }
      const { counts, queued, queuedCount } = snapshot;
      if (counts.global >= limits.globalActiveWorkspaces) return;
      if (queued.length === 0) return;
      // The store returns only each principal's FIFO head, so a deep backlog
      // cannot hide another principal from the round-robin rotation.
      const byPrincipal = this.groupQueuedByPrincipal(queued);
      const rotation = this.principalRotation(byPrincipal);
      const before = counts.global;
      if (!(await this.admitRound(byPrincipal, rotation, counts))) return;
      if (counts.global >= limits.globalActiveWorkspaces) return;
      // All rows in this snapshot were admitted; new arrivals wait for the next tick.
      if (queuedCount === queued.length && counts.global - before === queued.length) return;
    }
  }

  private async authorized(row: WorkspaceRow): Promise<boolean> {
    if (!this.context.deps.authorizeLaunch) return true;
    try {
      return (await this.context.deps.authorizeLaunch(row)) === true;
    } catch {
      this.context.report(`admit.policy.${row.id}`, new Error("Launch policy unavailable"));
      return false;
    }
  }

  async launch(row: WorkspaceRow): Promise<boolean> {
    const { store, driver, secrets } = this.context.deps;
    if (!(await this.authorized(row))) return false;
    const now = this.context.now();
    const secret = secrets.generate();
    const registrationDigest = secrets.digest(secret);
    const registrationExpiresAt = new Date(now.getTime() + this.context.timeoutMs(row, "start"));
    const input: ProviderInput = {
      workspace_id: row.id,
      server_url: this.context.deps.workspaceServerUrl,
      registration_secret: secret,
      template_digest: row.templateDigest,
      template_name: row.templateName,
      template_version: row.templateVersion,
      launch_mode: row.launchMode,
      ...(row.sourceDescriptor ? { source: row.sourceDescriptor } : {}),
      ...(row.restoredFromCheckpointId && row.originWorkspaceId
        ? {
            restore: {
              checkpoint_id: row.restoredFromCheckpointId,
              origin_workspace_id: row.originWorkspaceId,
            },
          }
        : {}),
      ...(row.launchInput ? { launch_input: row.launchInput } : {}),
    };
    if (this.context.deps.warmPool) {
      const hit = await this.context.deps.warmPool.tryLease(row, input, registrationDigest, registrationExpiresAt);
      if (hit === "leased") return true;
      if (hit === "deferred") return false;
      if (this.context.deps.warmPool.missDecision(row) === "wait") return false;
    }
    const claimed = await store.claimWorkspaceAdmission({
      workspaceId: row.id,
      at: now,
      registrationDigest,
      registrationExpiresAt,
      limits: this.context.deps.limits,
    });
    if (!claimed) return false;
    let providerCreationStarted = false;
    try {
      const mounts = await this.prepareStorage(claimed);
      const runtimeSecrets = await this.resolveRuntimeSecrets(claimed);
      providerCreationStarted = true;
      const ref = await driver.create({
        workspace: claimed,
        input,
        mounts,
        secrets: runtimeSecrets,
      });
      await store.updateWorkspace(row.id, { providerKind: driver.kind, providerRef: ref }, this.context.now());
      return true;
    } catch (err) {
      this.context.report(`launch.${row.id}`, err);
      const at = this.context.now();
      if (!(await this.cleanupFailedLaunch(claimed, providerCreationStarted))) return false;
      if (claimed.launchAttempts < this.context.deps.limits.maxLaunchAttempts) {
        // No provider object was created; the bounded requeue is legal.
        await store.transition(row.id, {
          from: ["provisioning"],
          to: "queued",
          at,
          patch: { providerKind: null, providerRef: null, registrationDigest: null, registrationExpiresAt: null },
        });
      } else {
        const failurePatch = await this.context.captureLaunchFailure(row.id, err, at);
        await store.transition(row.id, {
          from: ["provisioning"],
          to: "failed",
          reason: "launch_failed",
          at,
          patch: {
            launchInput: null,
            registrationDigest: null,
            ...failurePatch,
          },
        });
        await this.context.cleanupWorkspaceStorage(claimed);
        await this.context.finishRestoreOperation(row, "failed", "restore_failed");
      }
      return false;
    }
  }

  private async resolveRuntimeSecrets(row: WorkspaceRow) {
    const spec = row.templateSnapshot.spec;
    if (spec.setup.some((step) => Object.values(step.env).some((value) => value.startsWith("secretRef:"))))
      throw new Error("secret.unavailable: setup environment credentials are not supported");
    if (runtimeCredentialReferences(spec).length && !this.context.deps.revokeWorkspaceLeases)
      throw new Error("secret.unavailable: no runtime issuer configured");
    return [];
  }

  private async cleanupFailedLaunch(row: WorkspaceRow, providerCreationStarted: boolean) {
    if (!providerCreationStarted) return true;
    try {
      await cleanupUncommittedProvider(
        this.context.deps.store,
        this.context.deps.driver,
        row,
        this.context.graceSeconds(row),
      );
      return true;
    } catch (error) {
      // Registration expiry retries cleanup without declaring the failed launch settled.
      this.context.report(`launch.cleanup.${row.id}`, error);
      return false;
    }
  }

  async prepareStorage(row: WorkspaceRow): Promise<RuntimeMountRef[]> {
    if (this.context.deps.transferRuntime) {
      return this.context.deps.transferRuntime.prepareStorage(row);
    }
    const mounts = row.templateSnapshot.spec.persistence.mounts;
    if (mounts.length === 0) return [];
    const storageDriver = this.context.deps.storageDriver;
    if (!storageDriver) {
      throw new Error("workspace.persistence_not_enabled: no storage driver configured");
    }
    const { store } = this.context.deps;
    let stored = await store.getWorkspaceStorage(row.id);
    if (!stored) {
      const now = this.context.now();
      stored = await store.insertWorkspaceStorage({
        id: randomUUID(),
        workspaceId: row.id,
        principalId: row.principalId,
        providerKind: storageDriver.kind,
        providerRef: {},
        state: "allocating",
        mountManifest: mounts,
        logicalBytes: null,
        fileCount: null,
        retainedUntil: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        lastErrorCode: null,
      });
    }
    let ref: StorageRef;
    if (Object.keys(stored.providerRef).length === 0) {
      const allocated = await storageDriver.allocate({
        storageId: stored.id,
        workspaceId: row.id,
        mounts,
        uid: row.templateSnapshot.spec.security.uid,
        gid: row.templateSnapshot.spec.security.gid,
      });
      ref = allocated.ref;
      const state = row.restoredFromCheckpointId ? "restoring" : "ready";
      await store.updateWorkspaceStorage(
        stored.id,
        { providerRef: allocated.ref, providerKind: storageDriver.kind, state },
        this.context.now(),
      );
      stored = { ...stored, providerRef: allocated.ref, state };
    } else {
      ref = stored.providerRef as StorageRef;
    }
    if (row.restoredFromCheckpointId && stored.state !== "ready") {
      const checkpoint = await store.getCheckpoint(row.restoredFromCheckpointId);
      if (checkpoint?.state !== "ready" || !checkpoint.providerRef || !checkpoint.manifest) {
        throw new Error("checkpoint.not_ready");
      }
      await storageDriver.cloneCheckpoint(checkpoint.providerRef as StorageRef, ref, checkpoint.manifest);
      await store.updateWorkspaceStorage(stored.id, { state: "ready" }, this.context.now());
    }
    if (row.restoredFromCheckpointId) {
      await this.context.finishRestoreOperation(row, "succeeded", null);
    }
    return await storageDriver.runtimeMounts(ref, mounts);
  }
}
