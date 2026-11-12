import { z } from "zod";

// Portable conversation context. Tool output is summarized, never copied verbatim.
export const PriorMessageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string() });
export type PriorMessage = z.infer<typeof PriorMessageSchema>;
