import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ManagerError } from "../accounts/errors";

export const ControllerFormatSchema = z.strictObject({
  pglite: z.string().min(1),
  postgres: z.string().min(1),
  migrations: z.array(z.strictObject({ name: z.string().min(1), hash: z.string().regex(/^[a-f0-9]{64}$/) })).min(1),
});
export const ReleaseSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  controllerImage: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
  data: ControllerFormatSchema,
  agentProtocol: z.number().int().positive(),
  upgradesFrom: z.array(z.string()),
  rollbackTo: z.array(z.string()),
  evidence: z.url(),
});
export const ReleaseCatalogSchema = z
  .array(ReleaseSchema)
  .max(64)
  .superRefine((releases, context) => {
    for (const key of ["version", "controllerImage"] as const)
      if (new Set(releases.map((release) => release[key])).size !== releases.length)
        context.addIssue({ code: "custom", message: `Release ${key} must be unique.` });
  });
export type Release = z.infer<typeof ReleaseSchema>;
export const ReleaseManifestSchema = z.strictObject({
  format: z.literal("pocketcoder-releases/v1"),
  releases: ReleaseCatalogSchema,
});
export const UpgradeSchema = z.strictObject({
  requestedVersion: z.string(),
  source: ReleaseSchema,
  target: ReleaseSchema,
  suspendId: z.uuid(),
  resumeId: z.uuid(),
  mode: z.enum(["upgrade", "rollback", "forward_fix", "restore"]),
});
export type Upgrade = z.infer<typeof UpgradeSchema>;

export function releaseVersion(releases: Release[], version: string) {
  const release = releases.find((entry) => entry.version === version);
  if (!release) throw new ManagerError(409, "release_not_tested");
  return release;
}
export function requireUpgrade(source: Release, target: Release) {
  const extendsSchema = isDeepStrictEqual(
    source.data.migrations,
    target.data.migrations.slice(0, source.data.migrations.length),
  );
  if (
    !target.upgradesFrom.includes(source.version) ||
    target.data.pglite !== source.data.pglite ||
    target.data.postgres !== source.data.postgres ||
    target.agentProtocol !== source.agentProtocol ||
    !extendsSchema
  )
    throw new ManagerError(409, "upgrade_not_tested");
}
export function requireRollback(upgrade: Upgrade) {
  if (
    !upgrade.target.rollbackTo.includes(upgrade.source.version) ||
    !isDeepStrictEqual(upgrade.source.data, upgrade.target.data) ||
    upgrade.source.agentProtocol !== upgrade.target.agentProtocol
  )
    throw new ManagerError(409, "rollback_incompatible");
}
