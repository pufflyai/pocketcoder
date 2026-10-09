import { z } from "zod";

export const SECRET_TYPES = ["registry"] as const;
export const SecretTypeSchema = z.enum(SECRET_TYPES);
export type SecretType = z.infer<typeof SecretTypeSchema>;
export const SecretNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const SecretParamsSchema = z.object({ name: SecretNameSchema });

const RegistryConfigSchema = z.strictObject({
  server: z
    .string()
    .max(255)
    .regex(/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/),
  username: z.string().min(1).max(1024),
  password: z.string().min(1).max(16_384),
});
export const SecretPutRequestSchema = z.strictObject({ type: z.literal("registry"), value: RegistryConfigSchema });
export type SecretPutRequest = z.infer<typeof SecretPutRequestSchema>;

export const SecretResourceSchema = z.strictObject({
  name: SecretNameSchema,
  type: SecretTypeSchema,
  updated_at: z.iso.datetime(),
  retired_at: z.iso.datetime().nullable(),
});
export type SecretResource = z.infer<typeof SecretResourceSchema>;
export const SecretListSchema = z.strictObject({ items: z.array(SecretResourceSchema) });
