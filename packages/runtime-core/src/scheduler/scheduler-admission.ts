import { randomUUID } from "node:crypto";
import {
  ApiError,
  managed,
  type ProviderInput,
  parseWorkloadTemplate,
  templateCredentialReferences,
  workloadSnapshotOf,
} from "@pstdio/pocketcoder-contracts";
import { ProviderNotSubmittedError } from "@pstdio/pocketcoder-runtime-contracts";
import type { RuntimeMountRef, StorageRef } from "../driver";

import type { ActiveCounts, WorkspaceRow } from "../types";
import { capacityReason, recordAdmissionReason, recordCapacityReasons } from "./admission-feedback";
import { launchInput } from "./launch-input";
import { cleanupUncommittedProvider } from "./provider-termination";
import type { SchedulerContext } from "./scheduler-base";
import { prepareWaitingRuntime } from "./waiting-runtime";

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
    return capacityReason(row, counts, this.context.deps.limits) === null;
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
      if (this.context.deps.admissionFenced?.()) break;
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
      if (this.context.deps.admissionFenced?.()) return;
      let snapshot: Awaited<ReturnType<typeof store.readAdmissionSnapshot>>;
      try {
        snapshot = await store.readAdmissionSnapshot();
      } catch (err) {
        this.context.report("admit.snapshot", err);
        return;
      }
      if (snapshot.queuedCount === 0) return;
      if (await recordCapacityReasons(this.context, snapshot.counts, snapshot)) {
        // Feedback bumps the cursor used by the atomic warm lease. Refresh
        // before policy evaluation; later changes still fail the stale guard.
        snapshot = await store.readAdmissionSnapshot();
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
      // All rows in this snapshot were admitted; new arrivals wait for the next tick.
      if (counts.global - before === queuedCount) return;
      await recordCapacityReasons(this.context, counts);
      if (counts.global >= limits.globalActiveWorkspaces) return;
    }
  }

  private async authorized(row: WorkspaceRow): Promise<boolean> {
    if (!this.context.deps.authorizeLaunch) return true;
    try {
      const decision = await this.context.deps.authorizeLaunch(row);
      if (decision === true) return true;
      await recordAdmissionReason(
        this.context,
        row.id,
        typeof decision === "object" ? decision.reason : "admission_denied",
      );
      return false;
    } catch {
      await recordAdmissionReason(this.context, row.id, "admission_unavailable");
      this.context.report(`admit.policy.${row.id}`, new Error("Launch policy unavailable"));
      return false;
    }
  }

  async launch(row: WorkspaceRow): Promise<boolean> {
    const { store, driver, secrets } = this.context.deps;
    if (!(await this.authorized(row))) return false;
    if (this.context.deps.admissionFenced?.()) return false;
    const now = this.context.now();
    const secret = secrets.generate();
    const registrationDigest = secrets.digest(secret);
    const registrationExpiresAt = new Date(now.getTime() + this.context.timeoutMs(row, "start"));
    const input = launchInput(row, this.context.deps.workspaceServerUrl, secret);
    const warm = await this.tryWarmLease(row, input, registrationDigest, registrationExpiresAt);
    if (warm !== undefined) return warm;
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
      await store.managed.capacity.claimLaunch(claimed.id, claimed.launchAttempts, this.context.now());
      providerCreationStarted = true;
      const ref = await driver.create({
        workspace: claimed,
        input,
        mounts,
        secrets: runtimeSecrets,
      });
      await store.updateWorkspace(row.id, { providerKind: driver.kind, providerRef: ref }, this.context.now());
      await this.prepareRuntime({ ...claimed, providerKind: driver.kind, providerRef: ref });
      return true;
    } catch (err) {
      if (capacityDenied(err, providerCreationStarted)) {
        await store.managed.capacity.notSubmitted(claimed.id, claimed.launchAttempts, this.context.now());
        await store.transition(row.id, {
          from: ["provisioning"],
          to: "queued",
          at: this.context.now(),
          reason: "admission_denied",
          patch: { launchAttempts: claimed.launchAttempts - 1, registrationDigest: null, registrationExpiresAt: null },
        });
        return false;
      }
      this.context.report(`launch.${row.id}`, err);
      const at = this.context.now();
      if (!(await this.cleanupFailedLaunch(claimed, providerCreationStarted, err))) return false;
      if (claimed.launchAttempts < this.context.deps.limits.maxLaunchAttempts) {
        // No provider object was created; the bounded requeue is legal.
        await store.transition(row.id, {
          from: ["provisioning"],
          to: "queued",
          at,
          patch: { providerKind: null, providerRef: null, registrationDigest: null, registrationExpiresAt: null },
        });
      } else {
        await this.failLaunch(claimed, err, at);
      }
      return false;
    }
  }

  private async tryWarmLease(
    row: WorkspaceRow,
    input: ProviderInput,
    registrationDigest: Uint8Array,
    registrationExpiresAt: Date,
  ) {
    const { store, warmPool } = this.context.deps;
    if (!warmPool || (await store.managed.capacity.managed(row.id))) return undefined;
    const hit = await warmPool.tryLease(row, input, registrationDigest, registrationExpiresAt);
    if (hit === "leased") return true;
    if (hit === "deferred" || warmPool.missDecision(row) === "wait") return false;
    return undefined;
  }

  private async failLaunch(row: WorkspaceRow, error: unknown, at: Date) {
    const store = this.context.deps.store;
    const failurePatch = await this.context.captureLaunchFailure(row.id, error, at);
    const pending = await store.transition(row.id, {
      from: ["provisioning"],
      to: "terminating",
      reason: "launch_failed",
      at,
      patch: { terminalIntent: "failed", registrationDigest: null, ...failurePatch },
    });
    if (!pending) return;
    try {
      await this.context.cleanupWorkspaceStorage(pending);
      await this.context.finishRestoreOperation(row, "failed", "restore_failed");
    } catch (cleanupError) {
      this.context.report(`launch.cleanup.${row.id}`, cleanupError);
      return;
    }
    await store.transition(row.id, {
      from: ["terminating"],
      to: "failed",
      reason: "launch_failed",
      at,
      patch: { launchInput: null },
    });
  }

  private async prepareRuntime(workspace: WorkspaceRow) {
    if (!workspace.templateSnapshot.manifest) return;
    const { store, driver, workloadLimits } = this.context.deps;
    await prepareWaitingRuntime(
      { store, driver, workloadLimits },
      workspace,
      workloadSnapshotOf(parseWorkloadTemplate(workspace.templateSnapshot.manifest)),
    );
  }

  private async resolveRuntimeSecrets(row: WorkspaceRow) {
    const spec = row.templateSnapshot.spec;
    if (spec.setup.some((step) => Object.values(step.env).some((value) => value.startsWith("secretRef:"))))
      throw new Error("secret.unavailable: setup environment credentials are not supported");
    // Managed sessions get credentials from their profile issuer. Any other workspace needs the controller vault.
    const managedSession = Boolean(row.metadata?.[managed.MANAGED_SESSION_METADATA]);
    if (
      templateCredentialReferences(row.templateSnapshot).length &&
      !managedSession &&
      !this.context.deps.workspaceIssuer
    )
      throw new Error("secret.unavailable: no runtime issuer configured");
    return [];
  }

  private async cleanupFailedLaunch(row: WorkspaceRow, providerCreationStarted: boolean, error: unknown) {
    // The driver proved it submitted nothing, so there is no provider object to clean up.
    if (!providerCreationStarted || error instanceof ProviderNotSubmittedError) {
      await this.context.deps.store.managed.capacity.notSubmitted(row.id, row.launchAttempts, this.context.now());
      return true;
    }
    try {
      await this.context.deps.store.managed.capacity.cleanupPending(row.id, row.launchAttempts, this.context.now());
      await cleanupUncommittedProvider(
        this.context.deps.store,
        this.context.deps.driver,
        row,
        this.context.graceSeconds(row),
        this.context.now(),
      );
      await this.context.deps.store.managed.capacity.cleanup(
        row.id,
        row.launchAttempts,
        "provider_fenced",
        this.context.now(),
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

function capacityDenied(error: unknown, submitted: boolean) {
  return (
    !submitted &&
    error instanceof ApiError &&
    ["budget.exhausted", "budget.conflict", "budget.not_found", "profile.not_found"].includes(error.code)
  );
}
