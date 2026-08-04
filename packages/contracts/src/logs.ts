import { z } from "zod";
import { CursorPageSchema, CursorQuerySchema } from "./pagination";

export const LogChunkSchema = z.object({
	seq: z.number().int().positive(),
	stream: z.string(),
	occurred_at: z.iso.datetime(),
	content: z.string(),
});

export type LogChunk = z.infer<typeof LogChunkSchema>;
export const LogListQuerySchema = CursorQuerySchema(1000, 200);
export const LogPageSchema = CursorPageSchema(LogChunkSchema);
