export type ReadinessCheck =
  | "database"
  | "schema"
  | "reconciliation"
  | "execution-dispatch"
  | "coordinator"
  | "policy-reconciliation"
  | "shared-storage"
  | "cleanup";
export type ReadinessStatus = "ok" | "pending" | "failed" | "disabled";

export interface ReadinessSnapshot {
  ok: boolean;
  checks: Record<ReadinessCheck, ReadinessStatus>;
  // Why a check is not ok, when the check can say.
  reasons?: Partial<Record<ReadinessCheck, string>>;
}

const HEALTHY_CHECKS: Record<ReadinessCheck, ReadinessStatus> = {
  database: "ok",
  schema: "ok",
  reconciliation: "ok",
  coordinator: "ok",
  "execution-dispatch": "ok",
  "policy-reconciliation": "disabled",
  "shared-storage": "disabled",
  cleanup: "ok",
};

export class Readiness {
  private readonly checks: Record<ReadinessCheck, ReadinessStatus>;
  private readonly reasons: Partial<Record<ReadinessCheck, string>> = {};

  constructor(
    initial: Partial<Record<ReadinessCheck, ReadinessStatus>> = {},
    private readonly metrics?: MetricSink,
  ) {
    this.checks = { ...HEALTHY_CHECKS, ...initial };
  }

  set(check: ReadinessCheck, status: ReadinessStatus, reason?: string): void {
    this.checks[check] = status;
    if (reason && status !== "ok") this.reasons[check] = reason;
    else delete this.reasons[check];
    if (status === "failed") this.metrics?.increment("readiness.failure.total", { check });
  }

  snapshot(): ReadinessSnapshot {
    const checks = { ...this.checks };
    return {
      ok: Object.values(checks).every((status) => status === "ok" || status === "disabled"),
      checks,
      ...(Object.keys(this.reasons).length ? { reasons: { ...this.reasons } } : {}),
    };
  }
}

import type { MetricSink } from "@pstdio/pocketcoder-runtime-core";
