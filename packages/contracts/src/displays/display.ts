import { z } from "zod";
import { ViewSessionSchema } from "../previews/view-session";

export const DisplaySchema = z.strictObject({ mode: z.enum(["desktop", "browser"]) });
export const DisplayOpenRequestSchema = z.strictObject({
  control: z.boolean().default(false),
  session: ViewSessionSchema.default({ mode: "local" }),
});

export const BROWSER_WIDTH = 1280;
export const BROWSER_HEIGHT = 800;
const coordinate = (max: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(max - 1);
const url = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }, "Browser navigation requires an HTTP or HTTPS URL without credentials.");
export const BrowserActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("navigate"), url }),
  z.strictObject({ action: z.literal("click"), x: coordinate(BROWSER_WIDTH), y: coordinate(BROWSER_HEIGHT) }),
  z.strictObject({ action: z.literal("text"), text: z.string().min(1).max(1024) }),
  z.strictObject({
    action: z.literal("key"),
    key: z.enum([
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Escape",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ]),
  }),
  z.strictObject({
    action: z.literal("scroll"),
    x: coordinate(BROWSER_WIDTH),
    y: coordinate(BROWSER_HEIGHT),
    deltaY: z.number().int().min(-1000).max(1000),
  }),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
