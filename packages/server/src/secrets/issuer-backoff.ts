import { ApiError } from "@pstdio/pocketcoder-contracts";

// Keep retry timing only. Credential bytes and failed request IDs never enter this map.
export function issuerBackoff(now = Date.now) {
  const retries = new Map<string, { delay: number; after: number }>();
  return {
    async run<T>(key: string, issue: () => Promise<T>) {
      const previous = retries.get(key);
      if (previous && now() < previous.after)
        throw new ApiError("secret.unavailable", "Session credentials are unavailable; issuer retry is pending.");
      try {
        const value = await issue();
        retries.delete(key);
        return value;
      } catch (error) {
        const delay = Math.min((previous?.delay ?? 500) * 2, 30_000);
        retries.set(key, { delay, after: now() + delay });
        throw error;
      }
    },
  };
}
