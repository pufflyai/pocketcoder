import { canonicalJson } from "@pstdio/pocketcoder-contracts";
import { and, eq } from "drizzle-orm";
import { type DatabaseContext, notifyChange } from "../../database/context";
import { transitionWorkspace } from "../workspaces/transitions";
import { checkpointDownloadAuthority } from "./download-authority";
import { lockStorageCapacity } from "./reservation-capacity";
import { transferDeadline } from "./transfer-authority";

export function createCheckpointRestoreSettlement(context: DatabaseContext) {
  const {
    db,
    tables: { checkpointTransfers: transfers, workspaces, workspaceOperations: operations },
  } = context;
  return async (workspaceId: string, connectionEpoch: number, check: () => void) => {
    const settled = await db.transaction(async (tx) => {
      await lockStorageCapacity(context, tx);
      check();
      const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
      if (workspace?.state !== "connected" || workspace.connectionEpoch !== connectionEpoch) return false;
      const [row] = await tx
        .select()
        .from(transfers)
        .where(
          and(
            eq(transfers.workspaceId, workspaceId),
            eq(transfers.direction, "download"),
            eq(transfers.state, "complete"),
            eq(transfers.connectionEpoch, connectionEpoch),
          ),
        )
        .for("update");
      if (!row) return false;
      // Transfer authority ends at installation. Setup still uses the workspace deadline.
      const authority = await checkpointDownloadAuthority(
        context,
        tx,
        { ...row, expiresAt: workspace.deadlineAt },
        check,
      );
      if (
        row.principalId !== authority.workspace.principalId ||
        row.archiveDigest !== authority.publication.archiveDigest ||
        row.storedBytes !== authority.publication.storedBytes ||
        row.expectedArchiveBytes !== authority.publication.storedBytes ||
        canonicalJson(row.summary) !== canonicalJson(authority.publication.summary) ||
        canonicalJson(row.declaredHeader) !== canonicalJson(authority.publication.declaredHeader)
      )
        throw new Error("Installed checkpoint receipt changed before readiness.");
      const at = new Date();
      const ready = await transitionWorkspace(context, tx, workspaceId, {
        from: ["connected"],
        to: "ready",
        at,
        expectedConnectionEpoch: connectionEpoch,
        patch: { readyAt: at, lastActivityAt: at, launchInput: null },
        check,
      });
      if (!ready) return false;
      await tx
        .update(operations)
        .set({ state: "succeeded", completedAt: at, updatedAt: at })
        .where(eq(operations.id, row.operationId));
      transferDeadline(workspace.deadlineAt, check);
      if (authority.checkpoint.expiresAt) transferDeadline(authority.checkpoint.expiresAt, check);
      return true;
    });
    if (settled) notifyChange(context, workspaceId);
    return settled;
  };
}
