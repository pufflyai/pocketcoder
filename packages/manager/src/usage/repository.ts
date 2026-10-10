import { and, count, desc, eq, gte, lt, max, sql } from "drizzle-orm";
import { ManagerError } from "../accounts/errors";
import type { ManagerContext } from "../database/context";
import { retainedSince, SAMPLE_INTERVAL_MS, sampleBucket } from "./window";

export type UsageSample = {
  accountId: string;
  sampledAt: Date;
  workspaces: number | null;
  warm: number | null;
  volumeBytes: number | null;
};

export function usageRepository({ db, tables: { accounts, usageSamples: samples }, validate }: ManagerContext) {
  return {
    async recordUsageSample(sample: UsageSample) {
      validate();
      await db
        .insert(samples)
        .values({ ...sample, bucketAt: sampleBucket(sample.sampledAt) })
        .onConflictDoNothing();
    },
    async pruneUsageSamples(now: Date) {
      validate();
      await db.delete(samples).where(lt(samples.sampledAt, retainedSince(now)));
    },
    async hasUsageSample(accountId: string, now: Date) {
      validate();
      const [sample] = await db
        .select({ accountId: samples.accountId })
        .from(samples)
        .where(and(eq(samples.accountId, accountId), eq(samples.bucketAt, sampleBucket(now))))
        .limit(1);
      return !!sample;
    },
    async getUsage(accountId: string, now = new Date()) {
      validate();
      return db.transaction(
        async (tx) => {
          const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
          if (!account) throw new ManagerError(404, "account_not_found");
          const from = new Date(Math.max(+account.createdAt, +retainedSince(now)));
          const range = and(eq(samples.accountId, accountId), gte(samples.sampledAt, from), lt(samples.sampledAt, now));
          const seconds = sql`greatest(0, extract(epoch from (least(${samples.bucketAt} + interval '1 minute', ${now.toISOString()}::timestamptz) - greatest(${samples.bucketAt}, ${from.toISOString()}::timestamptz))))`;
          // Aggregate in the database: thirteen months of minute samples should not fill manager memory.
          const [totals] = await tx
            .select({
              recorded: count(),
              workspaceSamples: count(samples.workspaces),
              volumeSamples: count(samples.volumeBytes),
              workspaceSeconds: sql<number | null>`sum(${samples.workspaces} * ${seconds})`.mapWith(Number),
              warmSeconds: sql<number | null>`sum(${samples.warm} * ${seconds})`.mapWith(Number),
              workspaceObserved:
                sql<number>`coalesce(sum(${seconds}) filter (where ${samples.workspaces} is not null), 0)`.mapWith(
                  Number,
                ),
              volumeObserved:
                sql<number>`coalesce(sum(${seconds}) filter (where ${samples.volumeBytes} is not null), 0)`.mapWith(
                  Number,
                ),
              peak: max(samples.workspaces),
              warmPeak: max(samples.warm),
            })
            .from(samples)
            .where(range);
          if (!totals) throw new Error("Usage aggregate missing");
          const [latest] = await tx.select().from(samples).where(range).orderBy(desc(samples.sampledAt)).limit(1);
          const duration = Math.max(0, (+now - +from) / 1000);
          return {
            account_id: accountId,
            estimated_workspace_seconds: totals.workspaceSeconds,
            observed_peak: totals.peak,
            estimated_warm_seconds: totals.warmSeconds,
            observed_warm_peak: totals.warmPeak,
            volume_bytes: latest?.volumeBytes ?? null,
            sampled_at: latest?.sampledAt.toISOString() ?? null,
            coverage: {
              from: from.toISOString(),
              to: now.toISOString(),
              sample_interval_seconds: SAMPLE_INTERVAL_MS / 1000,
              expected_samples: Math.max(
                0,
                Math.ceil(+now / SAMPLE_INTERVAL_MS) - Math.floor(+from / SAMPLE_INTERVAL_MS),
              ),
              recorded_samples: totals.recorded,
              workspace_samples: totals.workspaceSamples,
              volume_samples: totals.volumeSamples,
              workspace_observed_seconds: totals.workspaceObserved,
              workspace_gap_seconds: duration - totals.workspaceObserved,
              volume_observed_seconds: totals.volumeObserved,
              volume_gap_seconds: duration - totals.volumeObserved,
            },
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}
