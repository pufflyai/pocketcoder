import { z } from "zod";

const queue = z.strictObject({
  count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export function sessionQueueConfig(raw: string | undefined) {
  return raw === undefined ? undefined : queue.parse(JSON.parse(raw));
}
