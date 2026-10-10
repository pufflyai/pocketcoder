import { z } from "zod";

export const HttpsOriginSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}, "An exact HTTPS origin is required.");

export const ViewSessionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("local") }),
  z.strictObject({ mode: z.literal("top_level") }),
  z.strictObject({ mode: z.literal("embedded"), parentOrigin: HttpsOriginSchema }),
]);
export type ViewSessionOptions = z.infer<typeof ViewSessionSchema>;
export const PreviewOpenRequestSchema = z.strictObject({ session: ViewSessionSchema.default({ mode: "local" }) });
