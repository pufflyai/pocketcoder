import { z } from "zod";

const queue = z.strictObject({
  count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export function sessionQueueConfig(raw: string | undefined) {
  return raw === undefined ? undefined : queue.parse(JSON.parse(raw));
}

// How long a cancel or close may stay pending before it reports a missed deadline. No default.
export function sessionStopConfig(raw: string | undefined) {
  return raw === undefined ? undefined : z.coerce.number().int().positive().max(86400).parse(raw);
}

// How many recent events each session keeps for replay. Unset keeps every event until history deletion.
export function sessionEventRetentionConfig(raw: string | undefined) {
  return raw === undefined ? undefined : z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(raw);
}

// The managed-session settings a built server needs from the parsed configuration.
export function managedSessionDeps(config: {
  sessionQueueLimits?: ReturnType<typeof sessionQueueConfig>;
  sessionStopSeconds?: number;
  modelGateway?: import("../model-gateway/config").ModelGatewayConfig | null;
}) {
  return {
    sessionQueueLimits: config.sessionQueueLimits,
    sessionStopSeconds: config.sessionStopSeconds,
    modelGateway: config.modelGateway ?? undefined,
  };
}
