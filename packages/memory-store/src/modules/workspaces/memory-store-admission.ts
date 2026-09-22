import { canTransition, isTerminal, parseDurationMs } from "@pstdio/pocketcoder-contracts";
import type {
  ActiveCounts,
  StateHistoryRow,
  TransitionRequest,
  WorkspaceAdmissionClaim,
  WorkspacePatch,
  WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { purgedContentPatch } from "@pstdio/pocketcoder-runtime-contracts";
import { ACTIVE_STATES, CHANGE_PATCH_KEYS, type MemoryState } from "../../state/memory-store-base";

export class MemoryAdmissionStore {
  constructor(
    private readonly context: Pick<
      MemoryState,
      | "workspaces"
      | "notifyWorkspaceChange"
      | "changeWaiters"
      | "conversationStates"
      | "appendHistory"
      | "appendWorkspaceEvent"
      | "history"
    >,
  ) {}
  async listQueuedHeads(): Promise<WorkspaceRow[]> {
    const queued = [...this.context.workspaces.values()]
      .filter((w) => w.state === "queued")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const heads = new Map<string, WorkspaceRow>();
    for (const workspace of queued) {
      if (!heads.has(workspace.principalId)) heads.set(workspace.principalId, workspace);
    }
    return [...heads.values()].map((workspace) => ({ ...workspace }));
  }

  async listNonterminal(): Promise<WorkspaceRow[]> {
    return [...this.context.workspaces.values()].filter((w) => !isTerminal(w.state)).map((w) => ({ ...w }));
  }

  activeCounts(): ActiveCounts {
    const counts: ActiveCounts = { global: 0, byPrincipal: {}, byTemplate: {} };
    for (const w of this.context.workspaces.values()) {
      if (!ACTIVE_STATES.includes(w.state)) continue;
      counts.global += 1;
      counts.byPrincipal[w.principalId] = (counts.byPrincipal[w.principalId] ?? 0) + 1;
      counts.byTemplate[w.templateName] = (counts.byTemplate[w.templateName] ?? 0) + 1;
    }
    return counts;
  }

  async countActive(): Promise<ActiveCounts> {
    return this.activeCounts();
  }

  async countQueued(): Promise<number> {
    return [...this.context.workspaces.values()].filter((w) => w.state === "queued").length;
  }

  async claimWorkspaceAdmission(claim: WorkspaceAdmissionClaim): Promise<WorkspaceRow | null> {
    const workspace = this.context.workspaces.get(claim.workspaceId);
    if (workspace?.state !== "queued" || workspace.purgeRequestedAt) return null;
    const counts = this.activeCounts();
    if (counts.global >= claim.limits.globalActiveWorkspaces) return null;
    if ((counts.byPrincipal[workspace.principalId] ?? 0) >= claim.limits.perPrincipalActiveWorkspaces) {
      return null;
    }
    const templateLimit =
      claim.limits.perTemplateActiveWorkspaces[workspace.templateName] ?? claim.limits.globalActiveWorkspaces;
    if ((counts.byTemplate[workspace.templateName] ?? 0) >= templateLimit) return null;
    return this.transition(workspace.id, {
      from: ["queued"],
      to: "provisioning",
      at: claim.at,
      patch: {
        provisioningMode: "cold",
        registrationDigest: claim.registrationDigest,
        registrationExpiresAt: claim.registrationExpiresAt,
        launchAttempts: workspace.launchAttempts + 1,
      },
    });
  }

  async updateWorkspace(id: string, patch: WorkspacePatch, at: Date): Promise<void> {
    const row = this.context.workspaces.get(id);
    if (!row) return;
    Object.assign(row, patch);
    if (row.purgeRequestedAt) Object.assign(row, purgedContentPatch());
    const changed = Object.keys(patch).some((key) => CHANGE_PATCH_KEYS.has(key));
    if (changed) row.changeSeq += 1;
    row.updatedAt = at;
    if (changed) this.context.notifyWorkspaceChange(id);
  }

  async waitForWorkspaceChange(id: string, afterSeq: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const current = this.context.workspaces.get(id);
    if (!current || current.changeSeq > afterSeq || timeoutMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const waiters = this.context.changeWaiters.get(id) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        waiters.delete(settle);
        if (waiters.size === 0) this.context.changeWaiters.delete(id);
      };
      const settle = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("workspace change wait aborted"));
      };
      waiters.add(settle);
      this.context.changeWaiters.set(id, waiters);
      timer = setTimeout(settle, timeoutMs);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      const latest = this.context.workspaces.get(id);
      if (!latest || latest.changeSeq > afterSeq) settle();
    });
  }

  async transition(id: string, req: TransitionRequest): Promise<WorkspaceRow | null> {
    const row = this.context.workspaces.get(id);
    if (!row) return null;
    if (!req.from.includes(row.state)) return null;
    if (!canTransition(row.state, req.to)) return null;
    if (row.purgeRequestedAt && ["provisioning", "connected", "ready", "preserving", "queued"].includes(req.to))
      return null;
    const fromState = row.state;
    row.state = req.to;
    if (req.reason !== undefined) row.reasonCode = req.reason;
    if (req.patch) Object.assign(row, req.patch);
    if (row.purgeRequestedAt) Object.assign(row, purgedContentPatch());
    row.changeSeq += 1;
    row.updatedAt = req.at;
    if (isTerminal(req.to)) {
      row.terminalAt = req.at;
      row.launchInput = null;
      row.registrationDigest = null;
      const current = this.context.conversationStates.get(id);
      if (current?.status !== "deleted") {
        this.context.conversationStates.set(id, {
          workspaceId: id,
          status: "retained",
          expiresAt: new Date(
            req.at.getTime() + parseDurationMs(row.templateSnapshot.spec.persistence.conversationRetention),
          ),
          deletedAt: null,
          updatedAt: req.at,
        });
      }
    }
    this.context.appendHistory(row, fromState, req.to, row.reasonCode, req.at);
    this.context.appendWorkspaceEvent(row, req.at);
    this.context.notifyWorkspaceChange(id);
    return { ...row };
  }

  async listStateHistory(workspaceId: string): Promise<StateHistoryRow[]> {
    return this.context.history.filter((h) => h.workspaceId === workspaceId).map((h) => ({ ...h }));
  }
}
