import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { ManagerError } from "../accounts/errors";
import type { ManagerContext } from "../database/context";
import { requireRecoveryOperation, requireReplay, resolveRecovery, resolveUpgrade } from "./admission";
import type { Release } from "./releases";

export function upgradeRepository({ db, tables: { accounts, operations }, validate }: ManagerContext) {
  return {
    async beginUpgrade(accountId: string, requestId: string, version: string, releases: Release[], expiresAt: Date) {
      validate();
      return db.transaction(async (tx) => {
        const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for("update");
        if (expiresAt <= new Date()) throw new ManagerError(401, "unauthorized");
        if (!account) throw new ManagerError(404, "account_not_found");
        const [prior] = await tx
          .select()
          .from(operations)
          .where(and(eq(operations.accountId, accountId), eq(operations.requestId, requestId)));
        if (prior) {
          requireReplay(prior, version);
          return { account, operation: prior };
        }
        const [pending] = await tx
          .select()
          .from(operations)
          .where(and(eq(operations.accountId, accountId), inArray(operations.state, ["pending", "running"])));
        const { source, target } = resolveUpgrade(account, pending, version, releases);
        const [updated] = await tx
          .update(accounts)
          .set({ state: "upgrading" })
          .where(eq(accounts.id, accountId))
          .returning();
        const [operation] = await tx
          .insert(operations)
          .values({
            id: randomUUID(),
            accountId,
            requestId,
            kind: "upgrade",
            phase: "fence",
            state: "pending",
            createdAt: new Date(),
            upgrade: {
              requestedVersion: version,
              source,
              target,
              suspendId: randomUUID(),
              resumeId: randomUUID(),
              mode: "upgrade",
            },
          })
          .returning();
        if (!updated || !operation) throw new Error("Upgrade insert failed.");
        return { account: updated, operation };
      });
    },
    async recoverUpgrade(
      accountId: string,
      operationId: string,
      mode: "rollback" | "forward_fix" | "restore",
      version: string | undefined,
      releases: Release[],
      expiresAt: Date,
    ) {
      validate();
      return db.transaction(async (tx) => {
        const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for("update");
        if (expiresAt <= new Date()) throw new ManagerError(401, "unauthorized");
        if (!account) throw new ManagerError(404, "account_not_found");
        const [operation] = await tx.select().from(operations).where(eq(operations.id, operationId)).for("update");
        const current = requireRecoveryOperation(operation, accountId);
        const prior = current.upgrade;
        if (prior.mode === mode && (mode !== "forward_fix" || prior.target.version === version)) return current;
        const target = resolveRecovery(current, mode, version, releases);
        const proof = current.computeProof ?? {};
        // The replacement controller needs fresh death evidence. Keep the backup's original runtime proof.
        const { expectedControllers: _expected, controllerTermination: _termination, ...retained } = proof;
        const [updated] = await tx
          .update(operations)
          .set({
            phase: "controller",
            errorCode: null,
            upgrade: { ...prior, mode, target, resumeId: randomUUID() },
            computeProof: retained,
          })
          .where(eq(operations.id, operationId))
          .returning();
        if (!updated) throw new Error("Upgrade recovery update failed.");
        return updated;
      });
    },
    async installUpgradePlan(operationId: string) {
      validate();
      await db.transaction(async (tx) => {
        const [operation] = await tx.select().from(operations).where(eq(operations.id, operationId)).for("update");
        if (!operation?.upgrade) throw new Error("Upgrade manifest is missing.");
        const [account] = await tx.select().from(accounts).where(eq(accounts.id, operation.accountId)).for("update");
        if (!account) throw new Error("Upgrade account is missing.");
        await tx
          .update(accounts)
          .set({ plan: { ...account.plan, controllerImage: operation.upgrade.target.controllerImage } })
          .where(eq(accounts.id, account.id));
      });
    },
  };
}
