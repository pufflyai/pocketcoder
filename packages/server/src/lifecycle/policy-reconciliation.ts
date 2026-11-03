import { readFileSync } from "node:fs";
import type { WorkspaceStore } from "@pstdio/pocketcoder-runtime-core";
import type { launchPolicyConfig } from "./launch-policy";

// The policy ledger owns the retry list. Nothing can be forgotten when this
// process restarts or the last delivery response is lost.
export class PolicyReconciliation {
  private active: Promise<void> | undefined;
  constructor(
    private readonly store: Pick<WorkspaceStore, "getWorkspace">,
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    try {
      const response = await fetch(`${this.url.replace(/\/$/, "")}/${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("policy response");
      return await response.json();
    } catch {
      throw new Error("Policy reconciliation unavailable");
    }
  }

  tick(): Promise<void> {
    this.active ??= this.reconcile().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  async drain(): Promise<void> {
    await this.active?.catch(() => {});
  }

  private async reconcile(): Promise<void> {
    const pending = await this.post("pending", {});
    if (
      typeof pending !== "object" ||
      pending === null ||
      !("workspace_ids" in pending) ||
      !Array.isArray(pending.workspace_ids)
    ) {
      throw new Error("Invalid policy reconciliation response");
    }
    let failed = false;
    for (const id of pending.workspace_ids) {
      try {
        if (typeof id !== "string") throw new Error("Invalid workspace identity");
        const row = await this.store.getWorkspace(id);
        // A missing runtime row is never proof that a provider was not created.
        if (!row) throw new Error("Missing reconciliation workspace");
        const ref = row.providerRef;
        const result = await this.post("reconcile", {
          workspace_id: row.id,
          principal_id: row.principalId,
          external_id: row.externalId,
          template_name: row.templateName,
          launch_mode: row.launchMode,
          metadata: row.metadata,
          state: row.state,
          reason_code: row.reasonCode,
          launch_attempts: row.launchAttempts,
          provider_kind: row.providerKind,
          provider_ref: ref
            ? {
                id: ref.id,
                namespace: ref.namespace,
                poolRuntimeId: ref.poolRuntimeId,
                terminationEvidence: ref.terminationEvidence,
              }
            : null,
        });
        if (
          typeof result !== "object" ||
          result === null ||
          !("workspace_id" in result) ||
          result.workspace_id !== row.id ||
          !("released" in result) ||
          typeof result.released !== "boolean"
        ) {
          throw new Error("Invalid policy reconciliation response");
        }
        // An unproven termination stays pending in the hook's ledger and is retried next tick.
        // Failing readiness for it would take every other workspace out of service.
        if ("reason" in result && result.reason === "provider-unavailable") failed = true;
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error("Policy reconciliation unavailable");
  }
}

export function loadPolicyReconciliation(
  store: Pick<WorkspaceStore, "getWorkspace">,
  config: ReturnType<typeof launchPolicyConfig>,
) {
  if (!config) return undefined;
  const token = readFileSync(config.tokenFile, "utf8").trim();
  if (token.length < 24 || /\s/.test(token)) throw new Error("Invalid launch policy control token");
  return new PolicyReconciliation(store, config.url, token);
}
