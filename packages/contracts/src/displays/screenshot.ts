import { z } from "zod";

export const SCREENSHOT_MAX_BYTES = 4 * 1024 ** 2;
export const SCREENSHOT_MIN_PROTOCOL_VERSION = 11;
export const ScreenshotResourceSchema = z.strictObject({
  kind: z.literal("screenshot"),
  id: z.uuid(),
  workspace_id: z.uuid(),
  content_type: z.literal("image/png"),
  bytes: z.number().int().min(1).max(SCREENSHOT_MAX_BYTES),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expires_at: z.iso.datetime(),
});
export type ScreenshotResource = z.infer<typeof ScreenshotResourceSchema>;
export const ScreenshotCapturePayload = z.strictObject({
  output_id: z.uuid(),
  credential: z.string().min(32).max(128),
  url: z.url(),
  expires_at: z.iso.datetime(),
});
export type ScreenshotCapture = z.infer<typeof ScreenshotCapturePayload>;
