import { z } from "zod";

export const CursorSchema = z.string().min(1).max(2048);

export function CursorPageSchema<T extends z.ZodType>(item: T) {
	return z.object({
		items: z.array(item),
		next_cursor: CursorSchema.nullable(),
	});
}

export function CursorQuerySchema(maxLimit: number, defaultLimit: number) {
	return z.object({
		cursor: CursorSchema.optional(),
		limit: z.coerce.number().int().positive().max(maxLimit).default(defaultLimit),
	});
}
