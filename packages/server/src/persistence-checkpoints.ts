import { randomUUID } from "node:crypto";
import {
  ApiError,
  canonicalJson,
  digestOf,
  type ResolvedSource,
} from "@pstdio/pocketcoder-contracts";
import type {
  PrincipalRow,
  StorageRef,
  WorkspaceOperationRow,
} from "@pstdio/pocketcoder-runtime-core";
import { PersistenceRestoreService } from "./persistence-restore";

export class PersistenceCheckpointService extends PersistenceRestoreService {
  async verify(
    principal: PrincipalRow,
    checkpointId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceOperationRow> {
    const requestDigest = digestOf({ checkpoint_id: checkpointId });
    const replay = await this.replayedOperation(
      principal.id,
      "verify",
      idempotencyKey,
      requestDigest,
      "Changed verify request.",
    );
    if (replay) {
      this.throwFailedOperation(replay);
      return replay;
    }
    const checkpoint = await this.getCheckpointOwned(principal, checkpointId);
    if (checkpoint.state !== "ready" || !checkpoint.providerRef || !checkpoint.manifest) {
      throw new ApiError("checkpoint.not_ready", "Checkpoint is not ready.");
    }
    const now = this.now();
    const inserted = await this.insertOperation({
      id: randomUUID(),
      principalId: principal.id,
      kind: "verify",
      state: "running",
      idempotencyKey,
      requestDigest,
      workspaceId: checkpoint.workspaceId,
      checkpointId,
      resultWorkspaceId: null,
      reasonCode: null,
      attemptCount: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    if (inserted.conflict) {
      throw new ApiError("idempotency.conflict", "Changed verify request.");
    }
    if (!inserted.created) {
      this.throwFailedOperation(inserted.operation);
      return inserted.operation;
    }
    try {
      await this.storageDriver().verifyCheckpoint(
        checkpoint.providerRef as StorageRef,
        checkpoint.manifest,
      );
      const done = this.now();
      await this.deps.store.updateOperation(
        inserted.operation.id,
        { state: "succeeded", completedAt: done },
        done,
      );
    } catch {
      await this.deps.store.updateCheckpoint(
        checkpoint.id,
        { state: "failed", reasonCode: "checkpoint_corrupt" },
        this.now(),
      );
      await this.failOperation(inserted.operation.id, "checkpoint_corrupt");
      throw new ApiError("checkpoint.corrupt", "Checkpoint integrity verification failed.");
    }
    return (await this.deps.store.getOperation(inserted.operation.id)) ?? inserted.operation;
  }

  async sourceResolved(workspaceId: string, source: ResolvedSource): Promise<void> {
    const workspace = await this.deps.store.getWorkspace(workspaceId);
    if (
      !workspace?.sourceDescriptor ||
      workspace.sourceDescriptor.repository !== source.repository ||
      workspace.sourceDescriptor.revision !== source.requested_revision
    ) {
      throw new Error("source resolution does not match the requested descriptor");
    }
    if (
      workspace.resolvedSource &&
      canonicalJson(workspace.resolvedSource) !== canonicalJson(source)
    ) {
      throw new Error("resolved source is immutable");
    }
    await this.deps.store.updateWorkspace(workspaceId, { resolvedSource: source }, this.now());
  }

  async publishOutput(workspaceId: string, name: string, value: unknown): Promise<void> {
    const workspace = await this.deps.store.getWorkspace(workspaceId);
    if (!workspace) throw new Error("workspace not found");
    const declaration = workspace.templateSnapshot.spec.outputs[name];
    if (!declaration) throw new Error("output is not declared by the template");
    if (Buffer.byteLength(canonicalJson(value)) > 16_384) {
      throw new Error("output exceeds the maximum encoded size");
    }
    if (
      declaration.type === "gitSha" &&
      (typeof value !== "string" || !/^[0-9a-f]{40,64}$/.test(value))
    ) {
      throw new Error("output is not a valid git SHA");
    }
    if (declaration.type === "string") {
      if (typeof value !== "string" || value.length > declaration.maxLength) {
        throw new Error("output is not a bounded string");
      }
    }
    if (declaration.type === "httpsUrl") {
      if (typeof value !== "string" || value.length > declaration.maxLength) {
        throw new Error("output is not a bounded HTTPS URL");
      }
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("output is not a safe HTTPS URL");
      }
    }
    await this.deps.store.appendOutput({
      workspaceId,
      seq: 0,
      name,
      value,
      occurredAt: this.now(),
    });
    const at = this.now();
    await this.deps.store.appendEvent(
      workspaceId,
      "workspace.output_published",
      {
        id: randomUUID(),
        type: "workspace.output_published",
        occurred_at: at.toISOString(),
        workspace_id: workspaceId,
        name,
        value,
      },
      at,
    );
  }
}
