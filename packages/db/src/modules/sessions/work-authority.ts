import type { Scope } from "@pstdio/pocketcoder-contracts";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { authorityContext, unavailable } from "../managed/authority-context";
import { sessionWriter } from "./observations";

export function workAuthority(context: DatabaseContext) {
  const auth = authorityContext(context);
  const writer = sessionWriter(context);
  // Close retries pass allowClosed so a lost close reply can still return its receipt.
  return async (tx: Transaction, keyId: string, sessionId: string, scope: Scope, allowClosed = false) => {
    const actor = await auth.caller(tx, keyId, scope);
    const id = { principalId: actor.authority.principalId, sessionId };
    const row = await writer.read(tx, id, scope === "sessions:read" ? "share" : "update");
    const profile = await auth.profile(tx, id.principalId, row.session.profileId, row.session.profileRevision);
    await auth.validateScopes(tx, id.principalId, profile.profile);
    const [template] = await tx
      .select()
      .from(context.tables.templates)
      .where(eq(context.tables.templates.digest, profile.profile.templateDigest));
    if (!template || !actor.authority.templateNames.some((name) => name === "*" || name === template.name))
      throw unavailable();
    if (scope === "sessions:write" && !allowClosed && row.session.state === "closed")
      throw new ApiError("session.closed", "Session is closed.");
    return { id, row, profile: profile.profile };
  };
}
