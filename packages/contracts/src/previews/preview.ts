import { z } from "zod";

export { PREVIEW_COOKIE, PREVIEW_FRAME_BYTES, PREVIEW_MIN_PROTOCOL_VERSION, PREVIEW_QUEUE_BYTES } from "./limits";
export const PreviewNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,19}$/)
  .refine(
    (name) =>
      !new Set(["display", "control", "agent", "supervisor", "vnc", "cdp"]).has(name) && !name.startsWith("pc-"),
    "reserved preview name",
  );

const RESERVED_PORTS = new Set([3284, 5900, 5901, 6080, 9222, 9229]);
export const PreviewSchema = z.strictObject({
  port: z
    .number()
    .int()
    .min(1024)
    .max(65_535)
    .refine((port) => !RESERVED_PORTS.has(port), "reserved port"),
});
export const PreviewsSchema = z
  .record(PreviewNameSchema, PreviewSchema)
  .refine((previews) => Object.keys(previews).length <= 16, "at most 16 previews");
export const PreviewOpenResponseSchema = z.object({ url: z.url(), expires_at: z.iso.datetime() });
export const PreviewListSchema = z.array(z.object({ name: PreviewNameSchema, port: z.number().int() }));
export const PreviewSocketPayload = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("open"),
    request_id: z.uuid(),
    name: z.union([PreviewNameSchema, z.literal("display")]),
    path: z.string().max(8192),
    origin: z.url(),
    cookie: z.string().max(8192).optional(),
    protocols: z.array(z.string().max(128)).max(16),
  }),
  z.object({ op: z.literal("ready"), request_id: z.uuid(), protocol: z.string().max(128) }),
  z.object({
    op: z.literal("data"),
    request_id: z.uuid(),
    seq: z.number().int().nonnegative(),
    binary: z.boolean(),
    content_b64: z.string().max(87_384),
  }),
  z.object({ op: z.literal("ack"), request_id: z.uuid(), seq: z.number().int().nonnegative() }),
  z.object({ op: z.literal("close"), request_id: z.uuid() }),
]);
export type PreviewSocketMessage = z.infer<typeof PreviewSocketPayload>;

export function previewTarget(port: number, path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\r\n\0]/.test(path)) {
    throw new Error("invalid preview path");
  }
  const url = new URL(`http://127.0.0.1:${port}${path}`);
  if (url.host !== `127.0.0.1:${port}`) throw new Error("invalid preview destination");
  return url;
}
