import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ManagerError } from "../accounts/errors";
import type { ManagerConfig } from "../config";
import type { ManagerContext } from "./context";
export const hash = (input: string) => createHash("sha256").update(input).digest("hex");

export function accountRepository({ db, tables: { accounts, operations }, validate }: ManagerContext) {
  async function getAccount(id: string) {
    validate();
    const [row] = await db.select().from(accounts).where(eq(accounts.id, id));
    return row ?? null;
  }
  async function getOperation(id: string) {
    validate();
    const [row] = await db.select().from(operations).where(eq(operations.id, id));
    return row ?? null;
  }
  return {
    getAccount,
    getOperation,
    async createAccount(requestId: string, input: { name: string }, plan: ManagerConfig, authorityExpiresAt: Date) {
      validate();
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 83))`);
        if (authorityExpiresAt <= new Date()) throw new ManagerError(401, "unauthorized");
        const [prior] = await tx.select().from(accounts).where(eq(accounts.requestId, requestId));
        const digest = hash(JSON.stringify(input));
        if (prior) {
          if (prior.requestDigest !== digest) throw new ManagerError(409, "idempotency_conflict");
          const [operation] = await tx
            .select()
            .from(operations)
            .where(and(eq(operations.accountId, prior.id), eq(operations.kind, "provision")));
          if (!operation) throw new Error("Account operation missing");
          return { account: prior, operation };
        }
        const id = randomUUID();
        const at = new Date();
        const [account] = await tx
          .insert(accounts)
          .values({
            id,
            name: input.name,
            namespace: `pc-account-${id.replaceAll("-", "")}`,
            requestId,
            requestDigest: digest,
            plan,
            state: "provisioning",
            createdAt: at,
          })
          .returning();
        const [operation] = await tx
          .insert(operations)
          .values({ id: randomUUID(), accountId: id, requestId, state: "pending", createdAt: at })
          .returning();
        if (!account || !operation) throw new Error("Account insert failed");
        return { account, operation };
      });
    },
    async listAccounts() {
      validate();
      return db.select().from(accounts).orderBy(asc(accounts.createdAt));
    },
    async pendingOperations() {
      validate();
      return db
        .select()
        .from(operations)
        .where(inArray(operations.state, ["pending", "running"]))
        .orderBy(asc(operations.createdAt));
    },
    async startOperation(id: string) {
      validate();
      await db.update(operations).set({ state: "running", errorCode: null }).where(eq(operations.id, id));
    },
    async recordError(id: string) {
      validate();
      const operation = await getOperation(id);
      await db
        .update(operations)
        .set({ errorCode: `${operation?.kind}_retry` })
        .where(eq(operations.id, id));
    },
    async setOperationPhase(
      id: string,
      phase: "controller" | "scale" | "capture" | "fence" | "restore" | "recover" | "open",
    ) {
      validate();
      await db.update(operations).set({ phase }).where(eq(operations.id, id));
    },
    async finishAccount(accountId: string, operationId: string, state: "ready" | "suspended" = "ready") {
      validate();
      await db.transaction(async (tx) => {
        await tx.update(accounts).set({ state }).where(eq(accounts.id, accountId));
        await tx
          .update(operations)
          .set({ state: "succeeded", phase: "complete", errorCode: null, completedAt: new Date() })
          .where(eq(operations.id, operationId));
      });
    },
  };
}
