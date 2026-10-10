import { z } from "zod";

export const DisplaySchema = z.strictObject({ mode: z.literal("desktop") });
export const DisplayOpenRequestSchema = z.strictObject({ control: z.boolean().default(false) });
