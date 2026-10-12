import type { ControllerHealthSchema } from "@pstdio/pocketcoder-server/monitoring";
import type { z } from "zod";
import type { Account } from "../database/store";
import type { prometheus } from "./prometheus";

export function accountMetrics(
  output: ReturnType<typeof prometheus>,
  account: Account,
  health: z.infer<typeof ControllerHealthSchema> | null | undefined,
  backupAt: Date | undefined,
  now: number,
) {
  const labels = { account: account.id };
  output.add("account_controller_expected", account.state === "ready" ? 1 : 0, labels);
  output.add("account_observed", health ? 1 : 0, labels);
  output.add("account_observation_age_seconds", health ? Math.max(0, now - health.sampledAt) : null, labels);
  output.add("account_backup_configured", account.plan.offNodeBackups ? 1 : 0, labels);
  output.add("account_backup_present", backupAt ? 1 : 0, labels);
  output.add("account_backup_age_seconds", backupAt ? Math.max(0, now - backupAt.getTime() / 1000) : null, labels);
  if (!health) return;
  output.add("account_ready", health.ready ? 1 : 0, labels);
  output.add("account_queue_count", health.queue.count, labels);
  output.add("account_queue_oldest_seconds", health.queue.oldestSeconds, labels);
  output.add("account_heartbeat_missing", health.heartbeat.missing, labels);
  output.add("account_heartbeat_oldest_seconds", health.heartbeat.oldestSeconds, labels);
  output.add("account_cleanup_count", health.cleanup.count, labels);
  output.add("account_cleanup_oldest_seconds", health.cleanup.oldestSeconds, labels);
  output.add("account_journal_configured", health.journal.configured ? 1 : 0, labels);
  output.add("account_journal_acknowledged", health.journal.lastAcknowledgedAt ? 1 : 0, labels);
  output.add(
    "account_journal_age_seconds",
    health.journal.lastAcknowledgedAt ? Math.max(0, now - health.journal.lastAcknowledgedAt) : null,
    labels,
  );
  output.add("account_journal_pending_seconds", health.journal.pendingSeconds ?? 0, labels);
  for (const [name, disk] of [
    ["data", health.disk],
    ["runtime", health.runtimeDisk],
  ] as const) {
    output.add(`account_${name}_disk_available_bytes`, disk.availableBytes, labels);
    output.add(`account_${name}_disk_total_bytes`, disk.totalBytes, labels);
  }
}
