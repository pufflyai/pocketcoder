import { z } from "zod";

export const ServiceStartSchema = z.strictObject({ startId: z.uuid() });
export const ServiceReceiptSchema = z.strictObject({
  workspaceId: z.uuid(),
  incarnationId: z.string().min(1).max(256),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  startId: z.uuid().nullable(),
  attemptId: z.uuid().nullable(),
  state: z.enum(["stopped", "starting", "running", "exited", "lost"]),
  pid: z.number().int().positive().nullable(),
  exitCode: z.number().int().nullable(),
  listener: z.enum(["unknown", "healthy", "unhealthy"]),
});
export type ServiceReceipt = z.infer<typeof ServiceReceiptSchema>;
