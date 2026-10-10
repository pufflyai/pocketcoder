import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ManagerError } from "../accounts/errors";
import { hash } from "./account-repository";
import type { ManagerContext } from "./context";

function validateExpiry(expiresAt: Date, authorityExpiresAt: Date, at: Date) {
  if (authorityExpiresAt <= at) throw new ManagerError(401, "unauthorized");
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= at ||
    expiresAt > authorityExpiresAt ||
    expiresAt.getTime() > at.getTime() + 24 * 3600_000
  )
    throw new ManagerError(400, "bootstrap_expiry_invalid");
}
function validateReplacement(
  current: { state: string; requestId: string; expiresAt: Date } | undefined,
  replacement: string | undefined,
  at: Date,
) {
  if (!current || replacement !== current.requestId || (current.state !== "completed" && current.expiresAt > at))
    throw new ManagerError(409, "bootstrap_replacement_required");
}
export function bootstrapRepository({
  db,
  tables: { accounts, operators, bootstrapRequests: requests },
  validate,
}: ManagerContext) {
  return {
    async createOperator(expiresAt: Date) {
      const at = new Date();
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt <= at ||
        expiresAt.getTime() > at.getTime() + 24 * 3600_000
      )
        throw new Error("Operator expiry must be finite and within 24 hours");
      validate();
      const token = randomBytes(32).toString("base64url");
      await db.insert(operators).values({ id: randomUUID(), digest: hash(token), createdAt: at, expiresAt });
      return token;
    },
    async operator(token: string) {
      validate();
      const [row] = await db
        .select()
        .from(operators)
        .where(eq(operators.digest, hash(token)));
      return row && row.expiresAt > new Date() ? row : null;
    },
    async beginBootstrap(
      accountId: string,
      input: { request_id: string; expires_at: string; replaces_request_id?: string },
      authorityExpiresAt: Date,
    ) {
      validate();
      const expiresAt = new Date(input.expires_at);
      const digest = hash(JSON.stringify(input));
      return db.transaction(async (tx) => {
        const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId)).for("update");
        const at = new Date();
        validateExpiry(expiresAt, authorityExpiresAt, at);
        if (!account || account.state !== "ready") throw new ManagerError(409, "account_not_ready");
        const [prior] = await tx
          .select()
          .from(requests)
          .where(and(eq(requests.accountId, accountId), eq(requests.requestId, input.request_id)));
        if (prior) {
          if (prior.requestDigest !== digest) throw new ManagerError(409, "idempotency_conflict");
          return prior;
        }
        if (account.bootstrapRequestId) {
          const [current] = await tx.select().from(requests).where(eq(requests.id, account.bootstrapRequestId));
          // An expired uncertain call cannot issue a live key. Replacement revokes its earlier key.
          validateReplacement(current, input.replaces_request_id, at);
        } else if (input.replaces_request_id) throw new ManagerError(409, "bootstrap_replacement_invalid");
        const [request] = await tx
          .insert(requests)
          .values({
            id: randomUUID(),
            accountId,
            requestId: input.request_id,
            requestDigest: digest,
            expiresAt,
            replacesRequestId: input.replaces_request_id,
            state: "pending",
            createdAt: at,
          })
          .returning();
        if (!request) throw new Error("Bootstrap request missing");
        await tx.update(accounts).set({ bootstrapRequestId: request.id }).where(eq(accounts.id, accountId));
        return request;
      });
    },
    async completeBootstrap(id: string, keyId: string) {
      validate();
      await db.update(requests).set({ state: "completed", keyId }).where(eq(requests.id, id));
    },
  };
}
