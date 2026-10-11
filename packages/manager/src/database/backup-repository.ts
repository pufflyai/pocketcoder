import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OffNodeBackupReceiptSchema } from "@pstdio/pocketcoder-db/off-node";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { ManagerError } from "../accounts/errors";
import type { ManagerContext } from "./context";

type Transaction = Parameters<Parameters<ManagerContext["db"]["transaction"]>[0]>[0];
function validateReplay(prior: { kind: string; backupId: string | null }, kind: string, backupId?: string) {
  if (prior.kind !== kind || prior.backupId !== (backupId ?? null)) throw new ManagerError(409, "idempotency_conflict");
}
function validateAdmission(
  account: { state: string; plan: { offNodeBackups?: boolean } },
  kind: "backup" | "restore",
  pending: unknown,
) {
  if (pending) throw new ManagerError(409, "account_operation_pending");
  if (!account.plan.offNodeBackups) throw new ManagerError(409, "off_node_not_configured");
  const expected = kind === "backup" ? "ready" : "suspended";
  if (account.state !== expected) throw new ManagerError(409, "account_state_conflict");
}

export function backupRepository({ db, tables: { accounts, operations, backups }, validate }: ManagerContext) {
  async function lockAccount(tx: Transaction, accountId: string, expiresAt: Date) {
    const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for("update");
    if (expiresAt <= new Date()) throw new ManagerError(401, "unauthorized");
    if (!account) throw new ManagerError(404, "account_not_found");
    return account;
  }
  async function requireBackup(tx: Transaction, accountId: string, backupId?: string) {
    if (!backupId) throw new ManagerError(404, "backup_not_found");
    const [backup] = await tx
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.accountId, accountId)));
    if (!backup) throw new ManagerError(404, "backup_not_found");
  }
  return {
    async beginBackupOperation(
      accountId: string,
      kind: "backup" | "restore",
      requestId: string,
      expiresAt: Date,
      backupId?: string,
    ) {
      validate();
      return db.transaction(async (tx) => {
        const account = await lockAccount(tx, accountId, expiresAt);
        const [prior] = await tx
          .select()
          .from(operations)
          .where(and(eq(operations.accountId, accountId), eq(operations.requestId, requestId)));
        if (prior) {
          validateReplay(prior, kind, backupId);
          return { account, operation: prior };
        }
        const [pending] = await tx
          .select()
          .from(operations)
          .where(and(eq(operations.accountId, accountId), inArray(operations.state, ["pending", "running"])));
        validateAdmission(account, kind, pending);
        if (kind === "restore") await requireBackup(tx, accountId, backupId);
        const [updated] =
          kind === "restore"
            ? await tx.update(accounts).set({ state: "restoring" }).where(eq(accounts.id, accountId)).returning()
            : [account];
        const [operation] = await tx
          .insert(operations)
          .values({
            id: randomUUID(),
            accountId,
            requestId,
            kind,
            backupId,
            computeProof: kind === "restore" ? { sourceVolumeName: account.volumeName } : null,
            phase: kind === "backup" ? "capture" : "fence",
            state: "pending",
            createdAt: new Date(),
          })
          .returning();
        if (!updated || !operation) throw new Error("Backup operation insert failed.");
        return { account: updated, operation };
      });
    },
    async saveBackup(operationId: string, input: unknown) {
      validate();
      const receipt = OffNodeBackupReceiptSchema.parse(input);
      if (receipt.operationId !== operationId) throw new Error("Backup operation identity differs.");
      await db.transaction(async (tx) => {
        const [operation] = await tx.select().from(operations).where(eq(operations.id, operationId)).for("update");
        if (operation?.kind !== "backup" || operation.accountId !== receipt.accountId)
          throw new Error("Backup account identity differs.");
        const [account] = await tx.select().from(accounts).where(eq(accounts.id, receipt.accountId));
        if (!account) throw new Error("Backup account is missing.");
        const [prior] = await tx.select().from(backups).where(eq(backups.id, operationId));
        if (prior && !isDeepStrictEqual(prior.receipt, receipt)) throw new Error("Backup receipt identity differs.");
        await tx
          .insert(backups)
          .values({
            id: operationId,
            accountId: receipt.accountId,
            receipt,
            volumeName: account.volumeName,
            createdAt: new Date(),
          })
          .onConflictDoNothing();
        await tx
          .update(operations)
          .set({ state: "succeeded", phase: "complete", errorCode: null, completedAt: new Date() })
          .where(eq(operations.id, operationId));
      });
    },
    async listBackups(accountId: string) {
      validate();
      return db.select().from(backups).where(eq(backups.accountId, accountId)).orderBy(asc(backups.createdAt));
    },
    async getBackup(id: string) {
      validate();
      const [row] = await db.select().from(backups).where(eq(backups.id, id));
      return row ?? null;
    },
    async sourceComputeProof(accountId: string) {
      validate();
      const [operation] = await db
        .select()
        .from(operations)
        .where(
          and(eq(operations.accountId, accountId), eq(operations.kind, "suspend"), eq(operations.state, "succeeded")),
        )
        .orderBy(desc(operations.createdAt))
        .limit(1);
      if (!operation?.computeProof) throw new Error("Source suspension has no retained compute-death proof.");
      return operation.computeProof;
    },
    async saveComputeProof(operationId: string, proof: Record<string, unknown>) {
      validate();
      await db.update(operations).set({ computeProof: proof }).where(eq(operations.id, operationId));
    },
    async markRestorePrepared(operationId: string, volumeName: string) {
      validate();
      await db.transaction(async (tx) => {
        const [operation] = await tx.select().from(operations).where(eq(operations.id, operationId)).for("update");
        if (operation?.kind !== "restore" || operation.phase !== "restore")
          throw new Error("Restore operation phase differs.");
        await tx.update(accounts).set({ volumeName }).where(eq(accounts.id, operation.accountId));
        await tx.update(operations).set({ phase: "recover" }).where(eq(operations.id, operationId));
      });
    },
  };
}
