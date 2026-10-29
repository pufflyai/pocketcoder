import { z } from "zod";
import { SCOPES } from "../common/scopes";

export const PrincipalGrantsSchema = z.strictObject({
  scopes: z.array(z.enum(SCOPES)).max(SCOPES.length),
  templates: z.array(z.string().min(1).max(128)).max(100),
});
export const PrincipalCreateRequestSchema = PrincipalGrantsSchema.extend({ name: z.string().min(1).max(128) });
export type PrincipalCreateRequest = z.infer<typeof PrincipalCreateRequestSchema>;
export const PrincipalResourceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  scopes: z.array(z.string()),
  templates: z.array(z.string()),
  disabled_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
});
export type PrincipalResource = z.infer<typeof PrincipalResourceSchema>;
export const PrincipalListResponseSchema = z.object({ items: z.array(PrincipalResourceSchema) });

export const PrincipalUpdateRequestSchema = PrincipalGrantsSchema.partial()
  .extend({ disabled: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, { message: "Provide a grant or disabled status." });
export type PrincipalUpdateRequest = z.infer<typeof PrincipalUpdateRequestSchema>;
