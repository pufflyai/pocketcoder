import { canTransition, isTerminal, parseDurationMs } from "@pstdio/pocketcoder-contracts";
import type {
	ActiveCounts,
	StateHistoryRow,
	TransitionRequest,
	WorkspaceAdmissionClaim,
	WorkspacePatch,
	WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-contracts";

import { ACTIVE_STATES, CHANGE_PATCH_KEYS } from "./memory-store-base";
import { MemoryWorkspaceStore } from "./memory-store-workspaces";

export class MemoryAdmissionStore extends MemoryWorkspaceStore {
	async listQueuedHeads(): Promise<WorkspaceRow[]> {
		const queued = [...this.workspaces.values()]
			.filter((w) => w.state === "queued")
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
		const heads = new Map<string, WorkspaceRow>();
		for (const workspace of queued) {
			if (!heads.has(workspace.principalId)) heads.set(workspace.principalId, workspace);
		}
		return [...heads.values()].map((workspace) => ({ ...workspace }));
	}

	async listNonterminal(): Promise<WorkspaceRow[]> {
		return [...this.workspaces.values()].filter((w) => !isTerminal(w.state)).map((w) => ({ ...w }));
	}

	protected activeCounts(): ActiveCounts {
		const counts: ActiveCounts = { global: 0, byPrincipal: {}, byTemplate: {} };
		for (const w of this.workspaces.values()) {
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
		return [...this.workspaces.values()].filter((w) => w.state === "queued").length;
	}

	async claimWorkspaceAdmission(claim: WorkspaceAdmissionClaim): Promise<WorkspaceRow | null> {
		const workspace = this.workspaces.get(claim.workspaceId);
		if (workspace?.state !== "queued") return null;
		const counts = this.activeCounts();
		if (counts.global >= claim.limits.globalActiveWorkspaces) return null;
		if (
			(counts.byPrincipal[workspace.principalId] ?? 0) >= claim.limits.perPrincipalActiveWorkspaces
		) {
			return null;
		}
		const templateLimit =
			claim.limits.perTemplateActiveWorkspaces[workspace.templateName] ??
			claim.limits.globalActiveWorkspaces;
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
		const row = this.workspaces.get(id);
		if (!row) return;
		Object.assign(row, patch);
		const changed = Object.keys(patch).some((key) => CHANGE_PATCH_KEYS.has(key));
		if (changed) row.changeSeq += 1;
		row.updatedAt = at;
		if (changed) this.notifyWorkspaceChange(id);
	}

	async waitForWorkspaceChange(
		id: string,
		afterSeq: number,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		const current = this.workspaces.get(id);
		if (!current || current.changeSeq > afterSeq || timeoutMs <= 0) return;
		await new Promise<void>((resolve, reject) => {
			const waiters = this.changeWaiters.get(id) ?? new Set<() => void>();
			let timer: ReturnType<typeof setTimeout>;
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				waiters.delete(settle);
				if (waiters.size === 0) this.changeWaiters.delete(id);
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
			this.changeWaiters.set(id, waiters);
			timer = setTimeout(settle, timeoutMs);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			const latest = this.workspaces.get(id);
			if (!latest || latest.changeSeq > afterSeq) settle();
		});
	}

	async transition(id: string, req: TransitionRequest): Promise<WorkspaceRow | null> {
		const row = this.workspaces.get(id);
		if (!row) return null;
		if (!req.from.includes(row.state)) return null;
		if (!canTransition(row.state, req.to)) return null;
		const fromState = row.state;
		row.state = req.to;
		if (req.reason !== undefined) row.reasonCode = req.reason;
		if (req.patch) Object.assign(row, req.patch);
		row.changeSeq += 1;
		row.updatedAt = req.at;
		if (isTerminal(req.to)) {
			row.terminalAt = req.at;
			row.launchInput = null;
			row.registrationDigest = null;
			const current = this.conversationStates.get(id);
			if (current?.status !== "deleted") {
				this.conversationStates.set(id, {
					workspaceId: id,
					status: "retained",
					expiresAt: new Date(
						req.at.getTime() +
							parseDurationMs(row.templateSnapshot.spec.persistence.conversationRetention),
					),
					deletedAt: null,
					updatedAt: req.at,
				});
			}
		}
		this.appendHistory(row, fromState, req.to, row.reasonCode, req.at);
		this.appendWorkspaceEvent(row, req.at);
		this.notifyWorkspaceChange(id);
		return { ...row };
	}

	async listStateHistory(workspaceId: string): Promise<StateHistoryRow[]> {
		return this.history.filter((h) => h.workspaceId === workspaceId).map((h) => ({ ...h }));
	}

	// --- Storage, checkpoints, operations, and outputs ---
}
