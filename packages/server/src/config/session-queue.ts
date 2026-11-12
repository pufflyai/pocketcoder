import { z } from "zod";

const queue = z.strictObject({
  count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export function sessionQueueConfig(raw: string | undefined) {
  return raw === undefined ? { count: 8, bytes: 8388608 } : queue.parse(JSON.parse(raw));
}

// How many recent events each session keeps for replay. Unset keeps every event until history deletion.
export function sessionEventRetentionConfig(raw: string | undefined) {
  return raw === undefined ? undefined : z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(raw);
}

// The managed-session settings a built server needs from the parsed configuration.
export function managedSessionDeps(config: {
  sessionSeedBytes?: number;
  sessionQueueLimits?: ReturnType<typeof sessionQueueConfig>;
}) {
  return {
    sessionQueueLimits: config.sessionQueueLimits,
    sessionSeedBytes: config.sessionSeedBytes,
  };
}

export type SessionConfig = ReturnType<typeof sessionConfig>;
// Queue and history seed defaults keep a fresh controller usable.
export function sessionConfig(env: Record<string, string | undefined>) {
  return {
    sessionSeedBytes:
      env.POCKETCODER_SESSION_SEED_BYTES === undefined
        ? 1048576
        : z.coerce.number().int().positive().parse(env.POCKETCODER_SESSION_SEED_BYTES),
    sessionQueueLimits: sessionQueueConfig(env.POCKETCODER_SESSION_QUEUE),
    sessionEventRetention: sessionEventRetentionConfig(env.POCKETCODER_SESSION_EVENT_RETENTION),
  };
}
