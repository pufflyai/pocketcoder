import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { ManagerError } from "../accounts/errors";
import type { ManagerContext } from "./context";

const states = { suspend: { from: "ready", to: "suspending" }, resume: { from: "suspended", to: "resuming" } } as const;
function validateTransition(state: string, kind: "suspend" | "resume", pending: unknown) {
  if (pending) throw new ManagerError(409, "account_operation_pending");
  if (state !== states[kind].from) throw new ManagerError(409, "account_state_conflict");
}
function validateReplay(prior: { kind: string }, kind: string) {
  if (prior.kind !== kind) throw new ManagerError(409, "idempotency_conflict");
}

export function lifecycleRepository({ db, tables: { accounts, operations }, validate }: ManagerContext) {
  return {
    async beginLifecycle(accountId: string, kind: "suspend" | "resume", requestId: string, expiresAt: Date) {
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
          validateReplay(prior, kind);
          return { account, operation: prior };
        }
        const [pending] = await tx
          .select()
          .from(operations)
          .where(and(eq(operations.accountId, accountId), inArray(operations.state, ["pending", "running"])));
        validateTransition(account.state, kind, pending);
        const state = states[kind].to;
        const [updated] = await tx.update(accounts).set({ state }).where(eq(accounts.id, accountId)).returning();
        const [operation] = await tx
          .insert(operations)
          .values({ id: randomUUID(), accountId, requestId, kind, state: "pending", createdAt: new Date() })
          .returning();
        if (!updated || !operation) throw new Error("Lifecycle insert failed");
        return { account: updated, operation };
      });
    },
  };
}
