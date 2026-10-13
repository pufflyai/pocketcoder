export interface Thresholds {
  diskFraction: number;
  diskBytes: number;
  queueSeconds: number;
  heartbeatSeconds: number;
  cleanupSeconds: number;
  backupSeconds: number;
  journalSeconds: number;
  observationSeconds: number;
  credentialSeconds: number;
  capacityFraction: number;
}
const defaults: Thresholds = {
  diskFraction: 0.15,
  diskBytes: 1024 ** 3,
  queueSeconds: 120,
  heartbeatSeconds: 60,
  cleanupSeconds: 300,
  backupSeconds: 86400,
  journalSeconds: 60,
  observationSeconds: 120,
  credentialSeconds: 3600,
  capacityFraction: 0.15,
};

export function monitoringRules(operator: string, runbookUrl: string, input: Partial<Thresholds> = {}, hold = "2m") {
  const limits = { ...defaults, ...input };
  for (const value of Object.values(limits))
    if (!Number.isFinite(value) || value < 0) throw new Error("Alert thresholds must be finite and nonnegative.");
  const rule = (name: string, family: string, expr: string, response: string) => ({
    alert: `Pocketcoder${name}`,
    expr,
    for: hold,
    labels: { severity: "warning", operator, family },
    annotations: { summary: response, runbook_url: `${runbookUrl}#${family}`, response },
  });
  const disk = (scope: string) =>
    `(pocketcoder_${scope}_disk_available_bytes / pocketcoder_${scope}_disk_total_bytes < ${limits.diskFraction}) or (pocketcoder_${scope}_disk_available_bytes < ${limits.diskBytes})`;
  return {
    groups: [
      {
        name: "pocketcoder-health",
        rules: [
          rule(
            "DiskHeadroom",
            "disk",
            `${disk("account_data")} or ${disk("account_runtime")} or ${disk("manager")}`,
            "Pause new work. Check disk usage. Remove only confirmed unused data or grow the affected volume.",
          ),
          rule(
            "QueueDelay",
            "queue",
            `pocketcoder_account_queue_oldest_seconds > ${limits.queueSeconds}`,
            "Check queued work and available runtime capacity. Cancel abandoned requests or add approved capacity.",
          ),
          rule(
            "HeartbeatLag",
            "heartbeat",
            `(pocketcoder_account_heartbeat_missing > 0) or (pocketcoder_account_heartbeat_oldest_seconds > ${limits.heartbeatSeconds})`,
            "Check the account supervisor Pods and control channel. Restore connectivity before restarting work.",
          ),
          rule(
            "CleanupPending",
            "cleanup",
            `(pocketcoder_account_cleanup_oldest_seconds > ${limits.cleanupSeconds}) or (pocketcoder_manager_pending_oldest_seconds > ${limits.cleanupSeconds})`,
            "Inspect the pending operation. Restore provider or storage access, then let the same operation retry.",
          ),
          rule(
            "BackupAge",
            "backup",
            `(pocketcoder_account_backup_configured == 1) and on(account) ((pocketcoder_account_backup_present == 0) or (pocketcoder_account_backup_age_seconds > ${limits.backupSeconds}))`,
            "Run an account backup with a new request ID. Verify its receipt and off-node version before clearing the alert.",
          ),
          rule(
            "ManagerBackupAge",
            "manager-backup",
            `(pocketcoder_manager_backup_configured == 1) and ((pocketcoder_manager_backup_present == 0) or (pocketcoder_manager_backup_age_seconds > ${limits.backupSeconds}))`,
            "Run the manager backup service. Verify the encrypted off-node receipt before clearing the alert.",
          ),
          rule(
            "ManagerBackupFailure",
            "manager-backup",
            "(pocketcoder_manager_backup_configured == 1) and ((pocketcoder_manager_backup_failed > 0) or (pocketcoder_manager_backup_in_progress_seconds > 1200))",
            "Check the manager backup service and storage access. Retry the same schedule window after fixing the failure.",
          ),
          rule(
            "ManagerBackupObservationGap",
            "manager-backup",
            `(pocketcoder_manager_backup_configured == 1) and ((pocketcoder_manager_backup_observed == 0) or (pocketcoder_manager_backup_observation_age_seconds > ${limits.observationSeconds}))`,
            "Restore private receipt access and verify its journal identity. Missing observations cannot prove backup health.",
          ),
          rule(
            "JournalPending",
            "journal",
            `(pocketcoder_account_journal_configured == 1) and on(account) ((pocketcoder_account_journal_acknowledged == 0) or (pocketcoder_account_journal_pending_seconds > ${limits.journalSeconds}))`,
            "Restore off-node storage access. Retry the failed journal action. Keep revoked keys revoked.",
          ),
          rule(
            "ObservationGap",
            "observation",
            `(up{job="pocketcoder-manager"} == 0) or absent(up{job="pocketcoder-manager"}) or (pocketcoder_cell_observed == 0) or (pocketcoder_cell_observation_age_seconds > ${limits.observationSeconds}) or ((pocketcoder_account_controller_expected == 1) and on(account) ((pocketcoder_account_observed == 0) or (pocketcoder_account_observation_age_seconds > ${limits.observationSeconds}) or (pocketcoder_account_ready == 0)))`,
            "Check the manager, metrics key expiry, and Kubernetes read access. Restore scraping; missing data cannot prove health.",
          ),
          rule(
            "CellCapacity",
            "capacity",
            `(pocketcoder_cell_disk_pressure > 0) or (pocketcoder_cell_unavailable > 0) or (pocketcoder_cell_allocatable_bytes <= 0) or (pocketcoder_cell_headroom_bytes / pocketcoder_cell_allocatable_bytes < ${limits.capacityFraction}) or (pocketcoder_cell_unplaced_bytes > pocketcoder_cell_headroom_bytes)`,
            "Check node readiness, DiskPressure, and Pod requests. Pause new work and restore or add approved capacity.",
          ),
          rule(
            "MetricsKeyExpiry",
            "credential",
            `pocketcoder_metrics_credential_expires_at_seconds - time() < ${limits.credentialSeconds}`,
            "Issue a finite metrics-only key. Replace the private credentials file atomically and verify the next scrape.",
          ),
        ],
      },
    ],
  };
}
