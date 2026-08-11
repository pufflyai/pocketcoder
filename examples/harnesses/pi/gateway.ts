import { startOpenAIGateway } from "./openai-gateway";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

const expiresAt = new Date(required("PI_GATEWAY_EXPIRES_AT"));
if (Number.isNaN(expiresAt.getTime())) throw new Error("PI_GATEWAY_EXPIRES_AT must be ISO 8601");

const gateway = startOpenAIGateway({
  apiKey: required("OPENAI_API_KEY"),
  clientBearer: required("PI_GATEWAY_BEARER"),
  allowedModel: required("PI_GATEWAY_ALLOWED_MODEL"),
  expiresAt,
  maxOutputTokens: positiveInteger("PI_GATEWAY_MAX_OUTPUT_TOKENS", 4096),
  maxRequestBytes: positiveInteger("PI_GATEWAY_MAX_REQUEST_BYTES", 2 * 1024 * 1024),
  maxTotalRequestBytes: positiveInteger("PI_GATEWAY_MAX_TOTAL_REQUEST_BYTES", 16 * 1024 * 1024),
  maxRequests: positiveInteger("PI_GATEWAY_MAX_REQUESTS", 50),
  organization: process.env.OPENAI_ORGANIZATION,
  project: process.env.OPENAI_PROJECT,
  hostname: "0.0.0.0",
  port: positiveInteger("PORT", 8080),
});

console.log(
  JSON.stringify({
    event: "pi_gateway.started",
    model: process.env.PI_GATEWAY_ALLOWED_MODEL,
    expires_at: expiresAt.toISOString(),
    port: gateway.port,
  }),
);
