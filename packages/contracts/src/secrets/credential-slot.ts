import { z } from "zod";

// Policy references identify trusted control-plane configuration, never a URL or credential.
export const CredentialSlotSchema = z.strictObject({
  policyRef: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/)
    .refine((value) => !value.includes("..")),
  policyVersion: z.string().min(1).max(128),
  binding: z.enum(["fixed-scope", "post-create-grant"]),
  delivery: z.literal("workspace-expiring-file"),
  maxLeaseSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type CredentialSlot = z.infer<typeof CredentialSlotSchema>;
