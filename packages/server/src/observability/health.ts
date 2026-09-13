export type ReadinessCheck = "database" | "schema" | "reconciliation" | "coordinator";
export type ReadinessStatus = "ok" | "pending" | "failed" | "disabled";

export interface ReadinessSnapshot {
  ok: boolean;
  checks: Record<ReadinessCheck, ReadinessStatus>;
}

const HEALTHY_CHECKS: Record<ReadinessCheck, ReadinessStatus> = {
  database: "ok",
  schema: "ok",
  reconciliation: "ok",
  coordinator: "ok",
};

export class Readiness {
  private readonly checks: Record<ReadinessCheck, ReadinessStatus>;

  constructor(
    initial: Partial<Record<ReadinessCheck, ReadinessStatus>> = {},
    private readonly metrics?: MetricSink,
  ) {
    this.checks = { ...HEALTHY_CHECKS, ...initial };
  }

  set(check: ReadinessCheck, status: ReadinessStatus): void {
    this.checks[check] = status;
    if (status === "failed") this.metrics?.increment("readiness.failure.total", { check });
  }

  snapshot(): ReadinessSnapshot {
    const checks = { ...this.checks };
    return {
      ok: Object.values(checks).every((status) => status === "ok" || status === "disabled"),
      checks,
    };
  }
}

import type { MetricSink } from "@pstdio/pocketcoder-runtime-core";
