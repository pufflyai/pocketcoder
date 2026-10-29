import type { CheckpointDownloadGrant } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { checkpointControllerAuthority, transferDeadline } from "./transfer-authority";

export async function checkpointDownloadAuthority(
  context: DatabaseContext,
  tx: Transaction,
  input: Omit<CheckpointDownloadGrant, "id" | "grantDigest">,
  check: () => void,
) {
  await checkpointControllerAuthority(context, tx, input.expiresAt, check);
  const {
    workspaceOperations: operations,
    workspaceCheckpoints: checkpoints,
    workspaces,
    principals,
    checkpointTransfers,
  } = context.tables;
  const [operation] = await tx.select().from(operations).where(eq(operations.id, input.operationId)).for("update");
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).for("update");
  const [checkpoint] = await tx.select().from(checkpoints).where(eq(checkpoints.id, input.checkpointId)).for("update");
  transferDeadline(input.expiresAt, check);
  if (
    !operation ||
    !workspace ||
    !checkpoint ||
    operation.kind !== "restore" ||
    !["pending", "running"].includes(operation.state) ||
    operation.resultWorkspaceId !== workspace.id ||
    operation.checkpointId !== checkpoint.id ||
    operation.workspaceId !== checkpoint.workspaceId ||
    operation.principalId !== workspace.principalId ||
    checkpoint.principalId !== workspace.principalId ||
    checkpoint.state !== "ready" ||
    checkpoint.deletedAt ||
    (checkpoint.expiresAt &&
      (!Number.isFinite(checkpoint.expiresAt.getTime()) || checkpoint.expiresAt <= new Date())) ||
    workspace.id === checkpoint.workspaceId ||
    workspace.restoredFromCheckpointId !== checkpoint.id ||
    workspace.originWorkspaceId !== checkpoint.workspaceId ||
    workspace.templateDigest !== checkpoint.templateDigest ||
    workspace.launchMode !== "restore" ||
    !["connected", "bootstrapping"].includes(workspace.state) ||
    workspace.terminalAt ||
    workspace.purgeRequestedAt ||
    workspace.connectionEpoch !== input.connectionEpoch ||
    !Number.isFinite(workspace.deadlineAt.getTime()) ||
    workspace.deadlineAt <= new Date() ||
    input.expiresAt > workspace.deadlineAt
  )
    throw new Error("Checkpoint download authority is invalid.");
  const [source] = await tx.select().from(workspaces).where(eq(workspaces.id, checkpoint.workspaceId)).for("update");
  const [principal] = await tx.select().from(principals).where(eq(principals.id, workspace.principalId)).for("update");
  const [publication] = await tx
    .select()
    .from(checkpointTransfers)
    .where(
      and(
        eq(checkpointTransfers.checkpointId, checkpoint.id),
        eq(checkpointTransfers.direction, "upload"),
        eq(checkpointTransfers.state, "complete"),
      ),
    )
    .for("update");
  transferDeadline(input.expiresAt, check);
  if (
    !source ||
    source.purgeRequestedAt ||
    source.principalId !== workspace.principalId ||
    !principal ||
    principal.disabledAt ||
    !publication ||
    publication.principalId !== workspace.principalId ||
    publication.workspaceId !== source.id ||
    !publication.declaredHeader ||
    !publication.summary ||
    !publication.archiveDigest ||
    !publication.storedBytes ||
    publication.declaredHeader.checkpoint_id !== checkpoint.id ||
    publication.declaredHeader.workspace_id !== source.id ||
    publication.declaredHeader.template_digest !== checkpoint.templateDigest
  )
    throw new Error("Checkpoint download publication authority is invalid.");
  return { workspace, checkpoint, publication };
}
