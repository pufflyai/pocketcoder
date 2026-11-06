import { z } from "zod";

export const ExecutionProfileSchema = z.strictObject({
  profileId: z.uuid(),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  isolationScopeId: z.uuid(),
  budgetScopeIds: z
    .array(z.uuid())
    .min(1)
    .max(1000)
    .refine((items) => new Set(items).size === items.length, "Values must be unique"),
  templateDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  allowedModels: z
    .array(z.string().min(1).max(256))
    .min(1)
    .max(1000)
    .refine((items) => new Set(items).size === items.length, "Values must be unique"),
  credentialBindingId: z.uuid().nullable(),
});
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;

export const SessionCreateSchema = z.strictObject({
  sessionId: z.uuid(),
  profileId: z.uuid(),
  profileRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type SessionCreate = z.infer<typeof SessionCreateSchema>;

export const SessionSchema = z.strictObject({
  sessionId: z.uuid(),
  profileId: z.uuid(),
  profileRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["provisioning", "ready", "suspended", "closed", "failed"]),
  reasonCode: z.string().min(1).max(256).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Session = z.infer<typeof SessionSchema>;
