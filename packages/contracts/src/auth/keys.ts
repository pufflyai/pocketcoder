import { z } from "zod";
import { SCOPES } from "../common/scopes";

export const KeyIssueRequestSchema = z.strictObject({
  request_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
  expires_at: z.iso.datetime(),
});
export type KeyIssueRequest = z.infer<typeof KeyIssueRequestSchema>;

export const KeyResourceSchema = z.object({
  id: z.uuid(),
  principal_id: z.uuid(),
  scopes: z.array(z.string()),
  effective_scopes: z.array(z.string()),
  managed_principal_ids: z.array(z.uuid()),
  issuance_request_id: z.string().nullable(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime().nullable(),
  revoked_at: z.iso.datetime().nullable(),
  last_used_at: z.iso.datetime().nullable(),
});
export type KeyResource = z.infer<typeof KeyResourceSchema>;
export const KeyIssueResponseSchema = z.object({ key: KeyResourceSchema, token: z.string().nullable() });
export type KeyIssueResponse = z.infer<typeof KeyIssueResponseSchema>;
export const KeyListResponseSchema = z.object({ items: z.array(KeyResourceSchema), next_cursor: z.uuid().nullable() });
export type KeyListResponse = z.infer<typeof KeyListResponseSchema>;
