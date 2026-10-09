import { z } from "zod";
import { SOURCE_CREDENTIAL_MAX_BYTES } from "./protocol-exec";

export const WorkspaceCredentialSchema = z.object({
  lease_id: z.uuid(),
  path: z.string().regex(/^\/run\/pocketcoder\/secrets\/leases\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  credential: z
    .string()
    .min(1)
    .max(SOURCE_CREDENTIAL_MAX_BYTES)
    .refine((value) => !value.includes("\0")),
  expires_at: z.iso.datetime(),
  purpose: z.enum(["setup-issuer", "runtime-issuer"]),
});
export type WorkspaceCredential = z.infer<typeof WorkspaceCredentialSchema>;
export const CredentialRenewPayload = z.object({ lease_id: z.uuid(), request_id: z.uuid() });
export const CredentialRenewedPayload = z.object({
  previous_lease_id: z.uuid(),
  request_id: z.uuid(),
  credential: WorkspaceCredentialSchema,
});
export const CredentialInstalledPayload = z.object({ previous_lease_id: z.uuid(), lease_id: z.uuid() });
