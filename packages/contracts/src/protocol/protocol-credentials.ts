import { z } from "zod";
import { SOURCE_CREDENTIAL_MAX_BYTES } from "./protocol-exec";

export const WorkspaceCredentialSchema = z.object({
  lease_id: z.uuid(),
  path: z
    .string()
    .regex(/^\/run\/pocketcoder\/secrets\/leases\/(?:sessions\/[0-9a-f-]{36}\/)?[A-Za-z0-9][A-Za-z0-9_.%-]{0,127}$/),
  // Set on a managed session's own lease; the workspace drops it alone when the session ends.
  session_id: z.uuid().optional(),
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
export const CredentialInstallPayload = z.object({ credentials: z.array(WorkspaceCredentialSchema).min(1).max(64) });
export const CredentialRemovePayload = z.object({ session_id: z.uuid() });
// Sent once a `credential_install` is written, so a session becomes ready only with its files present.
export const CredentialInstallAckPayload = z.object({ lease_ids: z.array(z.uuid()).min(1).max(64) });

export const CredentialRemoveAckPayload = z.object({ session_id: z.uuid() });
