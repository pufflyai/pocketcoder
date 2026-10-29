import { parseDurationMs } from "@pstdio/pocketcoder-contracts";
import type { ConversationRetention } from "@pstdio/pocketcoder-runtime-core";

export interface ConversationRetentionPolicy {
  maximumMs: number | null;
  // "until-deleted" keeps every conversation until a caller deletes it.
  override: number | "until-deleted" | null;
}

export const DEFAULT_CONVERSATION_RETENTION: ConversationRetentionPolicy = { maximumMs: null, override: null };

function duration(env: Record<string, string | undefined>, key: string) {
  const value = env[key];
  if (value === undefined) return null;
  try {
    return parseDurationMs(value);
  } catch {
    throw new Error(`${key} must be a duration such as 720h or "until-deleted"`);
  }
}

export function conversationRetentionPolicy(env: Record<string, string | undefined>): ConversationRetentionPolicy {
  const override =
    env.POCKETCODER_CONVERSATION_RETENTION === "until-deleted"
      ? "until-deleted"
      : duration(env, "POCKETCODER_CONVERSATION_RETENTION");
  return { maximumMs: duration(env, "POCKETCODER_MAX_CONVERSATION_RETENTION"), override };
}

// Snapshots keep the template value they were launched with; the server policy applies on top.
export function conversationRetention(policy: ConversationRetentionPolicy): ConversationRetention {
  return ({ conversationRetention }) => {
    if (policy.override === "until-deleted") return null;
    if (policy.override !== null) return policy.override;
    const template = parseDurationMs(conversationRetention);
    return policy.maximumMs === null ? template : Math.min(template, policy.maximumMs);
  };
}
