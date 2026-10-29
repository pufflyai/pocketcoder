import { z } from "zod";

const Prepared = z.strictObject({ inputUid: z.string().min(1), workspaceId: z.uuid(), templateDigest: z.string() });
export const RuntimeIdentitySchema = z.strictObject({
  kind: z.enum(["workspace", "warm"]),
  id: z.uuid(),
  provider: z.string(),
  ref: z.strictObject({
    kind: z.string(),
    id: z.string(),
    namespace: z.string().optional(),
    jobUid: z.string().optional(),
    poolRuntimeId: z.string().optional(),
    neverAdmitted: Prepared.optional(),
  }),
});
export type RuntimeIdentity = z.infer<typeof RuntimeIdentitySchema>;

// Names and immutable provider identities are enough; launch input and delegated grants stay in the controller.
export function runtimeIdentity(
  kind: RuntimeIdentity["kind"],
  id: string,
  provider: string | null,
  ref: Record<string, unknown>,
) {
  const fields: Record<string, unknown> = { kind: ref.kind, id: ref.id };
  for (const key of ["namespace", "jobUid", "poolRuntimeId"]) if (ref[key] !== undefined) fields[key] = ref[key];
  const evidence = ref.terminationEvidence as { neverAdmitted?: unknown } | undefined;
  if (evidence?.neverAdmitted) fields.neverAdmitted = evidence.neverAdmitted;
  return RuntimeIdentitySchema.parse({ kind, id, provider, ref: fields });
}
