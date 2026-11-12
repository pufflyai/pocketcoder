import { ApiError } from "@pstdio/pocketcoder-contracts";

// Keep retry timing only. Credential bytes and failed request IDs never enter this map.
export function issuerBackoff(now = Date.now, retentionMs = 60_000) {
  const retries = new Map<string, { delay: number; after: number; timer: ReturnType<typeof setTimeout> }>();
  const forget = (key: string) => {
    const entry = retries.get(key);
    if (entry) clearTimeout(entry.timer);
    retries.delete(key);
  };
  return {
    forget(prefix: string) {
      for (const key of retries.keys()) if (key.startsWith(prefix)) forget(key);
    },
    async run<T>(key: string, issue: () => Promise<T>) {
      const previous = retries.get(key);
      if (previous && now() < previous.after)
        throw new ApiError("secret.unavailable", "Session credentials are unavailable; issuer retry is pending.");
      try {
        const value = await issue();
        forget(key);
        return value;
      } catch (error) {
        const delay = Math.min((previous?.delay ?? 500) * 2, 30_000);
        forget(key);
        const entry = {
          delay,
          after: now() + delay,
          timer: setTimeout(() => {
            if (retries.get(key) === entry) retries.delete(key);
          }, delay + retentionMs),
        };
        entry.timer.unref();
        retries.set(key, entry);
        throw error;
      }
    },
  };
}
