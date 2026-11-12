import { ApiError, hasScope, type Scope, templateCredentialReferences } from "@pstdio/pocketcoder-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, QueryContext, Transaction } from "../../database/context";
import { lockKeyAuthority } from "../auth/authority";
import { profileTemplate } from "./profile-template";

export const unavailable = () => new ApiError("profile.not_found", "Session profile is unavailable.");
export const conflict = () => new ApiError("idempotency.conflict", "The request identity has changed.");

export function authorityContext({ tables }: DatabaseContext) {
  async function caller(tx: Transaction, keyId: string, scope: Scope, targetId?: string) {
    const found = await lockKeyAuthority(tx, tables, keyId, targetId);
    if (!hasScope(found.authority.scopes, scope))
      throw new ApiError("auth.missing_scope", `This operation requires ${scope}.`);
    return found;
  }
  async function profile(tx: QueryContext, principalId: string, name: string) {
    const p = tables.managedProfiles;
    const [row] = await tx
      .select()
      .from(p)
      .where(and(eq(p.principalId, principalId), eq(p.name, name)));
    if (!row) throw unavailable();
    const template = await profileTemplate(tx, tables.templates, row);
    return {
      ...row,
      profile: {
        name,
        template: row.template,
        templateVersion: row.templateVersion ?? template?.version ?? null,
        issuer: row.issuer ?? undefined,
        placement: row.placement,
        limits: { workspacesPerOwner: row.workspacesPerOwner, sessionsPerWorkspace: row.sessionsPerWorkspace },
        dispatchDeadlineSeconds: row.dispatchDeadlineSeconds,
        disabled: row.disabled,
        templateDigest: template?.digest ?? "",
        businessSlots: template
          ? templateCredentialReferences({ spec: template.spec, manifest: template.manifest ?? undefined })
          : [],
      },
    };
  }
  return { caller, profile };
}
