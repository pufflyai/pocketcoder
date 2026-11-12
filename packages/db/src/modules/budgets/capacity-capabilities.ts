import { type InstalledWorkload, PARALLEL_CONVERSATION_CAPABILITIES } from "@pstdio/pocketcoder-contracts";

export const parallel = (producer: InstalledWorkload | null | undefined) =>
  Boolean(
    producer &&
      PARALLEL_CONVERSATION_CAPABILITIES.every((c) => producer.capabilities.includes(c)) &&
      Object.values(producer.adapters).every((a) =>
        PARALLEL_CONVERSATION_CAPABILITIES.every((c) => a.capabilities.includes(c)),
      ),
  );
