import { digestOf, type ProviderInput } from "@pstdio/pocketcoder-contracts";
import type { Store, TemplateRow } from "./types";

export interface WarmPoolConfigEntry {
  template: string;
  version?: string;
  minReady: number;
  maxWarmAgeMs: number;
  missPolicy: "cold" | "wait";
  waitTimeoutMs: number;
}

export interface ResolvedWarmPool extends WarmPoolConfigEntry {
  templateRow: TemplateRow;
  eligibilityFingerprint: string;
}

export interface WarmPoolConnections {
  assign(runtimeId: string, input: ProviderInput): boolean;
  isConnected(runtimeId: string): boolean;
  close(runtimeId: string): void;
}

export interface WarmPoolMetrics {
  warmHits: number;
  misses: number;
  leaseFailures: number;
  replenishFailures: number;
  staleCleanups: number;
  leaseLatencyMsTotal: number;
}

export interface WarmPoolInventoryItem {
  template: string;
  version: string;
  template_digest: string;
  driver: string;
  desired: number;
  counts: Record<string, number>;
  oldest_ready_age_ms: number | null;
}

export interface WarmPoolInventory {
  items: WarmPoolInventoryItem[];
  metrics: WarmPoolMetrics & { average_lease_latency_ms: number };
}

export function warmPoolFingerprint(template: TemplateRow, driverKind: string): string {
  return digestOf({ template_digest: template.digest, driver: driverKind });
}

export function validateWarmPoolTemplate(template: TemplateRow): void {
  if (template.spec.persistence.mounts.length > 0) {
    throw new Error(
      `warm pool ${template.name}@${template.version} is ineligible: persistent mounts are not supported`,
    );
  }
  if (JSON.stringify(template.spec).includes('"secretRef:')) {
    throw new Error(
      `warm pool ${template.name}@${template.version} is ineligible: resolved secret mounts are not supported`,
    );
  }
}

export async function resolveWarmPools(
  store: Store,
  entries: WarmPoolConfigEntry[],
  driverKind: string,
  globalLimit: number,
): Promise<ResolvedWarmPool[]> {
  if (entries.reduce((sum, entry) => sum + entry.minReady, 0) > globalLimit) {
    throw new Error("warm pool desired capacity exceeds POCKETCODER_MAX_ACTIVE_WORKSPACES");
  }
  const seen = new Set<string>();
  const resolved: ResolvedWarmPool[] = [];
  for (const entry of entries) {
    const template = await store.getTemplate(entry.template, entry.version);
    if (!template || template.status === "retired") {
      throw new Error(
        `warm pool template not found: ${entry.template}${entry.version ? `@${entry.version}` : ""}`,
      );
    }
    validateWarmPoolTemplate(template);
    if (seen.has(template.digest)) {
      throw new Error(`duplicate warm pool template digest: ${template.digest}`);
    }
    seen.add(template.digest);
    resolved.push({
      ...entry,
      templateRow: template,
      eligibilityFingerprint: warmPoolFingerprint(template, driverKind),
    });
  }
  return resolved;
}
