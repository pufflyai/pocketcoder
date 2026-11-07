import { z } from "zod";
import { ConversationRecordDocumentSchema } from "../conversations/document";
import { ExportObjectSchema } from "./files";

export const ManagedHistoryQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const ManagedHistoryPageSchema = z.strictObject({
  records: z.array(ConversationRecordDocumentSchema),
  nextCursor: z.string().min(1).max(4096).nullable(),
  eventCursor: z.string().min(1).max(4096),
});
export const ManagedExportPageSchema = z.strictObject({
  items: z.array(ExportObjectSchema),
  nextCursor: z.string().min(1).max(4096).nullable(),
});
