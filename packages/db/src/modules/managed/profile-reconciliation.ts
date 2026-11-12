import { digestOf, managed } from "@pstdio/pocketcoder-contracts";
import { and, eq } from "drizzle-orm";
import { type DatabaseContext, lock, type Transaction } from "../../database/context";
import { unavailable } from "./authority-context";
import { profileTemplate } from "./profile-template";

type Tables = DatabaseContext["tables"];
function profileValues(input: managed.ProfileConfig) {
  const p = managed.ProfileConfigSchema.parse(input);
  return {
    template: p.template,
    templateVersion: p.templateVersion ?? null,
    issuer: p.issuer ?? null,
    placement: p.placement,
    workspacesPerOwner: p.limits.workspacesPerOwner,
    sessionsPerWorkspace: p.limits.sessionsPerWorkspace,
    dispatchDeadlineSeconds: p.dispatchDeadlineSeconds,
    disabled: false,
  };
}
async function applyProfile(
  tx: Transaction,
  tables: Tables,
  principalId: string,
  name: string,
  input: managed.ProfileConfig | undefined,
  previous: Tables["managedProfiles"]["$inferSelect"] | undefined,
  dryRun: boolean,
) {
  const table = tables.managedProfiles;
  const where = and(eq(table.principalId, principalId), eq(table.name, name));
  if (!input) {
    if (!previous || previous.disabled) return { changed: false, unavailable: false };
    if (!dryRun) await tx.update(table).set({ disabled: true, updatedAt: new Date() }).where(where);
    return { changed: true, unavailable: false };
  }
  const template = await profileTemplate(tx, tables.templates, input);
  const value = { ...profileValues(input), disabled: !template };
  if (previous && Object.entries(value).every(([k, v]) => previous[k as keyof typeof previous] === v))
    return { changed: false, unavailable: !template };
  if (!dryRun)
    await tx
      .insert(table)
      .values({ principalId, name, ...value, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [table.principalId, table.name], set: { ...value, updatedAt: new Date() } });
  return { changed: true, unavailable: !template };
}
async function applyIssuers(
  tx: Transaction,
  table: Tables["managedIssuers"],
  principalId: string,
  configured: Record<string, managed.SessionIssuer>,
  dryRun: boolean,
) {
  const changes: string[] = [];
  for (const [name, input] of Object.entries(configured)) {
    const config = managed.SessionIssuerSchema.parse(input);
    const [known] = await tx
      .select()
      .from(table)
      .where(and(eq(table.principalId, principalId), eq(table.name, name)));
    if (digestOf(known?.config ?? null) === digestOf(config)) continue;
    changes.push(name);
    if (!dryRun)
      await tx
        .insert(table)
        .values({ principalId, name, config })
        .onConflictDoUpdate({ target: [table.principalId, table.name], set: { config } });
  }
  return changes;
}
export function profileReconciliation({ db, tables }: DatabaseContext) {
  return async (
    principalId: string,
    declared: Record<string, managed.ProfileConfig>,
    configured: Record<string, managed.SessionIssuer>,
    dryRun = false,
  ) =>
    db.transaction(async (tx) => {
      await lock(tx, principalId, 32);
      const issuers = await applyIssuers(tx, tables.managedIssuers, principalId, configured, dryRun);
      const known = await tx
        .select()
        .from(tables.managedProfiles)
        .where(eq(tables.managedProfiles.principalId, principalId));
      const profiles: string[] = [];
      const unavailableProfiles: string[] = [];
      for (const name of new Set([...Object.keys(declared), ...known.map((p) => p.name)])) {
        const input = declared[name];
        if (input?.issuer && !configured[input.issuer]) throw unavailable();
        const result = await applyProfile(
          tx,
          tables,
          principalId,
          name,
          input,
          known.find((p) => p.name === name),
          dryRun,
        );
        if (result.changed) profiles.push(name);
        if (result.unavailable) unavailableProfiles.push(name);
      }
      return { profiles, issuers, unavailableProfiles };
    });
}
