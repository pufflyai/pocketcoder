import { timingSafeEqual } from "node:crypto";
import { CheckpointArchiveHeaderSchema, canonicalJson, digestOf } from "@pstdio/pocketcoder-contracts";
import type {
  CheckpointDownloadGrant,
  CheckpointTransferClaim,
  CheckpointUploadGrant,
  ReadStorageCapacity,
} from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { checkpointDownloadAuthority } from "./download-authority";
import { lockStorageCapacity, reserveStorage } from "./reservation-capacity";
import { checkpointUploadAuthority, checkpointUploadReservation, transferDeadline } from "./transfer-authority";
import { createCheckpointTransferLifecycle } from "./transfer-lifecycle";
import { assertCheckpointRetention } from "./transfer-retention";

function checker(context: DatabaseContext, checkInput: () => void) {
  return () => {
    checkInput();
    context.validateStorage?.();
  };
}

export function createCheckpointTransfers(context: DatabaseContext) {
  const {
    db,
    tables: { checkpointTransfers: transfers },
  } = context;
  return {
    ...createCheckpointTransferLifecycle(context),
    async grantUpload(input: CheckpointUploadGrant, readCapacity: ReadStorageCapacity, checkInput: () => void) {
      const check = checker(context, checkInput);
      check();
      const header = CheckpointArchiveHeaderSchema.parse(input.header);
      const grant = {
        ...input,
        header,
        grantDigest: Buffer.from(input.grantDigest),
        expiresAt: new Date(input.expiresAt),
      };
      if (
        grant.grantDigest.length !== 32 ||
        !Number.isSafeInteger(grant.expectedArchiveBytes) ||
        grant.expectedArchiveBytes <= 0 ||
        grant.expectedArchiveBytes > grant.reservedBytes ||
        grant.reservedFiles < 1
      )
        throw new Error("Invalid checkpoint upload declaration.");
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const { workspace } = await checkpointUploadAuthority(context, tx, grant, check);
        const policies = workspace.templateSnapshot.spec.persistence.mounts;
        if (
          header.checkpoint_id !== grant.checkpointId ||
          header.workspace_id !== workspace.id ||
          header.template_digest !== workspace.templateDigest ||
          header.mounts.length !== policies.length
        )
          throw new Error("Checkpoint upload declaration does not match its authority.");
        for (const [index, policy] of policies.entries()) {
          const actual = requiredRow(header.mounts[index]);
          if (
            actual.name !== policy.name ||
            actual.logical_bytes > policy.maxBytes ||
            actual.file_count > policy.maxFiles
          )
            throw new Error("Checkpoint upload declaration exceeds its admitted mounts.");
        }
        await assertCheckpointRetention(
          context,
          tx,
          header,
          workspace.principalId,
          grant.checkpointId,
          grant.retentionLimits,
        );
        const reservation = await reserveStorage(
          context,
          tx,
          {
            id: grant.reservationId,
            purpose: "checkpoint-upload",
            operationId: grant.operationId,
            workspaceId: workspace.id,
            principalId: workspace.principalId,
            reservedBytes: grant.reservedBytes,
            reservedFiles: grant.reservedFiles,
            expiresAt: grant.expiresAt,
          },
          readCapacity,
          check,
        );
        transferDeadline(grant.expiresAt, check);
        const at = new Date();
        const [row] = await tx
          .insert(transfers)
          .values({
            id: grant.id,
            operationId: grant.operationId,
            checkpointId: grant.checkpointId,
            workspaceId: workspace.id,
            principalId: workspace.principalId,
            direction: "upload",
            connectionEpoch: grant.connectionEpoch,
            state: "granted",
            requestDigest: digestOf({
              operationId: grant.operationId,
              checkpointId: grant.checkpointId,
              workspaceId: workspace.id,
              direction: "upload",
              connectionEpoch: grant.connectionEpoch,
              header,
              expectedArchiveBytes: grant.expectedArchiveBytes,
            }),
            grantDigest: grant.grantDigest,
            expiresAt: grant.expiresAt,
            reservationId: reservation.id,
            stagePath: `staging/${grant.id}/archive.tar`,
            declaredHeader: header,
            expectedArchiveBytes: grant.expectedArchiveBytes,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        transferDeadline(grant.expiresAt, check);
        return requiredRow(row);
      });
    },
    async grantDownload(input: CheckpointDownloadGrant, checkInput: () => void) {
      const check = checker(context, checkInput);
      const grant = { ...input, grantDigest: Buffer.from(input.grantDigest), expiresAt: new Date(input.expiresAt) };
      if (grant.grantDigest.length !== 32) throw new Error("Invalid checkpoint download grant.");
      check();
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const { workspace, publication } = await checkpointDownloadAuthority(context, tx, grant, check);
        const at = new Date();
        const [row] = await tx
          .insert(transfers)
          .values({
            id: grant.id,
            operationId: grant.operationId,
            checkpointId: grant.checkpointId,
            workspaceId: workspace.id,
            principalId: workspace.principalId,
            direction: "download",
            connectionEpoch: grant.connectionEpoch,
            state: "granted",
            grantDigest: grant.grantDigest,
            requestDigest: digestOf({
              operationId: grant.operationId,
              checkpointId: grant.checkpointId,
              workspaceId: workspace.id,
              direction: "download",
              connectionEpoch: grant.connectionEpoch,
            }),
            expiresAt: grant.expiresAt,
            declaredHeader: publication.declaredHeader,
            expectedArchiveBytes: publication.storedBytes,
            summary: publication.summary,
            archiveDigest: publication.archiveDigest,
            storedBytes: publication.storedBytes,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        transferDeadline(grant.expiresAt, check);
        return requiredRow(row);
      });
    },
    async claim(input: CheckpointTransferClaim, checkInput: () => void) {
      const check = checker(context, checkInput);
      check();
      const claim = { ...input, grantDigest: Buffer.from(input.grantDigest) };
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        check();
        const [row] = await tx.select().from(transfers).where(eq(transfers.id, claim.id)).for("update");
        if (
          row?.state !== "granted" ||
          row.operationId !== claim.operationId ||
          row.workspaceId !== claim.workspaceId ||
          row.direction !== claim.direction ||
          row.connectionEpoch !== claim.connectionEpoch ||
          !row.grantDigest ||
          row.grantDigest.length !== claim.grantDigest.length ||
          !timingSafeEqual(row.grantDigest, claim.grantDigest)
        )
          throw new Error("Checkpoint transfer grant authority is invalid.");
        const authority =
          row.direction === "upload"
            ? await checkpointUploadAuthority(context, tx, row, check)
            : await checkpointDownloadAuthority(context, tx, row, check);
        if (row.principalId !== authority.workspace.principalId)
          throw new Error("Checkpoint transfer principal differs from its source owner.");
        if (row.direction === "upload") await checkpointUploadReservation(context, tx, row, check);
        else if (
          "publication" in authority &&
          (row.archiveDigest !== authority.publication.archiveDigest ||
            row.storedBytes !== authority.publication.storedBytes ||
            row.expectedArchiveBytes !== authority.publication.storedBytes ||
            canonicalJson(row.declaredHeader) !== canonicalJson(authority.publication.declaredHeader) ||
            canonicalJson(row.summary) !== canonicalJson(authority.publication.summary))
        )
          throw new Error("Checkpoint download publication binding changed.");
        const [updated] = await tx
          .update(transfers)
          .set({ state: "streaming", grantDigest: null, updatedAt: new Date() })
          .where(eq(transfers.id, row.id))
          .returning();
        transferDeadline(row.expiresAt, check);
        return requiredRow(updated);
      });
    },
    async get(id: string) {
      const [row] = await db.select().from(transfers).where(eq(transfers.id, id));
      return row ?? null;
    },
  };
}
