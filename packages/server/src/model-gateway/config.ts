import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Plain HTTP is accepted only for a provider fixture on this machine. A real provider needs TLS.
const UpstreamUrlSchema = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    if (url.search || url.hash || url.username || url.password) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  }, "Use an https provider URL, or http only for a loopback fixture.")
  .transform((value) => value.replace(/\/+$/, ""));

const ModelSchema = z.strictObject({
  providerModel: z.string().min(1).max(256),
  minOutputTokens: z.number().int().positive(),
});

// Every value is deployment configuration. Model IDs, limits and the provider route have no defaults.
const ModelGatewaySettingsSchema = z.strictObject({
  provider: z.literal("openai"),
  upstreamUrl: UpstreamUrlSchema,
  providerAccountId: z.string().min(1).max(256),
  models: z.record(z.string().min(1).max(256), ModelSchema).refine((models) => Object.keys(models).length > 0, {
    message: "Configure at least one qualified model.",
  }),
  maxRequestBytes: z.number().int().positive(),
  maxConcurrentCalls: z.number().int().positive(),
  drainTimeoutMs: z.number().int().positive(),
});

export const ModelGatewayConfigSchema = ModelGatewaySettingsSchema.extend({ apiKey: z.string().min(1) });
export type ModelGatewayConfig = z.infer<typeof ModelGatewayConfigSchema>;

// The provider key is read from its own variable so it never sits inside the JSON settings,
// which operators copy into logs and tickets more often than secrets.
export function parseModelGatewayConfig(env: Record<string, string | undefined>): ModelGatewayConfig | null {
  const raw = env.POCKETCODER_MODEL_GATEWAY;
  if (!raw) return null;
  const apiKey = env.POCKETCODER_MODEL_GATEWAY_API_KEY;
  if (!apiKey) throw new Error("POCKETCODER_MODEL_GATEWAY_API_KEY is required when the model gateway is configured.");
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    throw new Error("POCKETCODER_MODEL_GATEWAY must be a JSON object.");
  }
  const parsed = ModelGatewaySettingsSchema.safeParse(settings);
  if (!parsed.success) throw new Error(`POCKETCODER_MODEL_GATEWAY is invalid: ${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, apiKey };
}
