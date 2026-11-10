import { z } from "zod";
import { InputObjectReferenceSchema } from "../attachments/input-reference";

export const WorkspaceRequestSchema = z.strictObject({
  requestId: z.uuid(),
  conversationId: z.uuid(),
  message: z
    .string()
    .min(1)
    .max(256 * 1024),
  files: z.array(InputObjectReferenceSchema).max(1000),
});
export type WorkspaceRequest = z.infer<typeof WorkspaceRequestSchema>;
