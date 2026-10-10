import { z } from "zod";
export const ManagerConfigSchema = z
  .object({
    controllerImage: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
    runtimeClassName: z
      .string()
      .max(253)
      .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/),
    storageClassName: z.string().min(1).optional(),
  })
  .strict();
export type ManagerConfig = z.infer<typeof ManagerConfigSchema>;
export const AccountInputSchema = z.object({ name: z.string().min(1).max(80) }).strict();
export const BootstrapInputSchema = z
  .object({
    request_id: z.uuid(),
    expires_at: z.iso.datetime(),
    replaces_request_id: z.uuid().optional(),
  })
  .strict();
