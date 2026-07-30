import { randomUUID } from "node:crypto";
import { canTransition, isTerminal, type WorkspaceState } from "@pstdio/pocketcoder-contracts";
import {
	type ActiveCounts,
	buildEventEnvelope,
	type LogRow,
	type MachineKeyRow,
	type OutboxRow,
	type PrincipalRow,
	type StateHistoryRow,
	type Store,
	type TemplateRow,
	type TemplateStatus,
	type TemplateUpsert,
	type TransitionRequest,
	type UpsertResult,
	type WorkspaceInsert,
	type WorkspaceListFilter,
	type WorkspacePatch,
	type WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-core";

// In-memory Store used by tests and single-process development. PostgreSQL
// (@pstdio/pocketcoder-db) is the durable implementation; both must satisfy the same
// behavior suite.

const ACTIVE_STATES: readonly WorkspaceState[] = [
	"provisioning",
	"connected",
	"ready",
	"terminating",
];
const MAX_LOG_BYTES = 10 * 1024 * 1024;

export class MemoryStore implements Store {
	private templates: TemplateRow[] = [];
	private principals: PrincipalRow[] = [];
	private keys: MachineKeyRow[] = [];
	private workspaces = new Map<string, WorkspaceRow>();
	private history: StateHistoryRow[] = [];
	private outbox: OutboxRow[] = [];
	private logs = new Map<string, LogRow[]>();
	private logBytes = new Map<string, number>();
	private claimedEvents = new Set<string>();

	async init(): Promise<void> {}
	async close(): Promise<void> {}

	// --- Templates ---

	async upsertTemplate(input: TemplateUpsert): Promise<UpsertResult> {
		const existing = this.templates.find(
			(t) => t.name === input.name && t.version === input.version,
		);
		if (existing) {
			if (existing.digest !== input.digest) {
				return { row: existing, created: false, conflict: true };
			}
			return { row: existing, created: false, conflict: false };
		}
		const row: TemplateRow = {
			id: randomUUID(),
			name: input.name,
			version: input.version,
			digest: input.digest,
			description: input.description,
			spec: input.spec,
			status: "active",
			createdAt: new Date(),
			retiredAt: null,
		};
		// Only the newest loaded version of a name stays "active"; earlier
		// ones remain selectable by explicit version.
		for (const t of this.templates) {
			if (t.name === input.name && t.status === "active") {
				t.status = "available";
			}
		}
		this.templates.push(row);
		return { row, created: true, conflict: false };
	}

	async listTemplates(names: string[] | null): Promise<TemplateRow[]> {
		return this.templates.filter((t) => !names || names.includes(t.name)).map((t) => ({ ...t }));
	}

	async getTemplate(name: string, version?: string): Promise<TemplateRow | null> {
		if (version) {
			return this.templates.find((t) => t.name === name && t.version === version) ?? null;
		}
		const active = this.templates.filter((t) => t.name === name && t.status === "active");
		return active[active.length - 1] ?? null;
	}

	async setTemplateStatus(name: string, version: string, status: TemplateStatus): Promise<void> {
		const row = this.templates.find((t) => t.name === name && t.version === version);
		if (row) {
			row.status = status;
			row.retiredAt = status === "retired" ? new Date() : null;
		}
	}

	// --- Principals and keys ---

	async createPrincipal(
		name: string,
		scopes: string[],
		templateNames: string[],
	): Promise<PrincipalRow> {
		if (this.principals.some((p) => p.name === name)) {
			throw new Error(`principal exists: ${name}`);
		}
		const row: PrincipalRow = {
			id: randomUUID(),
			name,
			scopes,
			templateNames,
			disabledAt: null,
			createdAt: new Date(),
		};
		this.principals.push(row);
		return row;
	}

	async getPrincipalByName(name: string): Promise<PrincipalRow | null> {
		return this.principals.find((p) => p.name === name) ?? null;
	}

	async listPrincipals(): Promise<PrincipalRow[]> {
		return this.principals.map((p) => ({ ...p }));
	}

	async setPrincipalDisabled(id: string, disabled: boolean): Promise<void> {
		const row = this.principals.find((p) => p.id === id);
		if (row) {
			row.disabledAt = disabled ? new Date() : null;
		}
	}

	async insertMachineKey(row: MachineKeyRow): Promise<void> {
		this.keys.push({ ...row });
	}

	async getMachineKeyWithPrincipal(
		keyId: string,
	): Promise<{ key: MachineKeyRow; principal: PrincipalRow } | null> {
		const key = this.keys.find((k) => k.id === keyId);
		if (!key) return null;
		const principal = this.principals.find((p) => p.id === key.principalId);
		if (!principal) return null;
		return { key: { ...key }, principal: { ...principal } };
	}

	async revokeMachineKey(keyId: string, at: Date): Promise<boolean> {
		const key = this.keys.find((k) => k.id === keyId);
		if (!key || key.revokedAt) return false;
		key.revokedAt = at;
		return true;
	}

	async touchMachineKey(keyId: string, at: Date): Promise<void> {
		const key = this.keys.find((k) => k.id === keyId);
		if (key) key.lastUsedAt = at;
	}

	// --- Workspaces ---

	async insertWorkspace(
		row: WorkspaceInsert,
	): Promise<{ workspace: WorkspaceRow; created: boolean; conflict: boolean }> {
		for (const existing of this.workspaces.values()) {
			if (existing.principalId !== row.principalId) continue;
			if (existing.idempotencyKey === row.idempotencyKey) {
				if (existing.requestDigest === row.requestDigest) {
					return { workspace: { ...existing }, created: false, conflict: false };
				}
				return { workspace: { ...existing }, created: false, conflict: true };
			}
			if (existing.externalId === row.externalId && !isTerminal(existing.state)) {
				return { workspace: { ...existing }, created: false, conflict: true };
			}
		}
		const snapshot = row.templateSnapshot;
		const workspace: WorkspaceRow = {
			id: row.id,
			principalId: row.principalId,
			externalId: row.externalId,
			idempotencyKey: row.idempotencyKey,
			requestDigest: row.requestDigest,
			templateId: row.templateId,
			templateName: snapshot.name,
			templateVersion: snapshot.version,
			templateDigest: snapshot.digest,
			templateSnapshot: snapshot,
			state: "queued",
			reasonCode: null,
			terminalIntent: null,
			launchInput: row.launchInput,
			providerKind: null,
			providerRef: null,
			registrationDigest: null,
			registrationExpiresAt: null,
			reconnectDigest: null,
			connectionEpoch: 0,
			connectedAt: null,
			disconnectedAt: null,
			readyAt: null,
			lastActivityAt: null,
			launchAttempts: 0,
			health: {},
			metadata: row.metadata,
			deadlineAt: row.deadlineAt,
			createdAt: row.createdAt,
			updatedAt: row.createdAt,
			terminalAt: null,
		};
		this.workspaces.set(workspace.id, workspace);
		this.appendHistory(workspace, null, "queued", null, row.createdAt);
		this.appendEvent(workspace, row.createdAt);
		return { workspace: { ...workspace }, created: true, conflict: false };
	}

	async getWorkspace(id: string): Promise<WorkspaceRow | null> {
		const row = this.workspaces.get(id);
		return row ? { ...row } : null;
	}

	async listWorkspaces(principalId: string, filter: WorkspaceListFilter): Promise<WorkspaceRow[]> {
		let rows = [...this.workspaces.values()].filter((w) => w.principalId === principalId);
		if (filter.externalId) rows = rows.filter((w) => w.externalId === filter.externalId);
		if (filter.state) rows = rows.filter((w) => w.state === filter.state);
		if (filter.template) rows = rows.filter((w) => w.templateName === filter.template);
		rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
		if (filter.cursor) {
			const idx = rows.findIndex((w) => w.id === filter.cursor);
			if (idx >= 0) rows = rows.slice(idx + 1);
		}
		return rows.slice(0, filter.limit).map((w) => ({ ...w }));
	}

	async listQueued(limit: number): Promise<WorkspaceRow[]> {
		return [...this.workspaces.values()]
			.filter((w) => w.state === "queued")
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
			.slice(0, limit)
			.map((w) => ({ ...w }));
	}

	async listNonterminal(): Promise<WorkspaceRow[]> {
		return [...this.workspaces.values()].filter((w) => !isTerminal(w.state)).map((w) => ({ ...w }));
	}

	async countActive(): Promise<ActiveCounts> {
		const counts: ActiveCounts = { global: 0, byPrincipal: {}, byTemplate: {} };
		for (const w of this.workspaces.values()) {
			if (!ACTIVE_STATES.includes(w.state)) continue;
			counts.global += 1;
			counts.byPrincipal[w.principalId] = (counts.byPrincipal[w.principalId] ?? 0) + 1;
			counts.byTemplate[w.templateName] = (counts.byTemplate[w.templateName] ?? 0) + 1;
		}
		return counts;
	}

	async countQueued(): Promise<number> {
		return [...this.workspaces.values()].filter((w) => w.state === "queued").length;
	}

	async updateWorkspace(id: string, patch: WorkspacePatch, at: Date): Promise<void> {
		const row = this.workspaces.get(id);
		if (!row) return;
		Object.assign(row, patch);
		row.updatedAt = at;
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
		row.updatedAt = req.at;
		if (isTerminal(req.to)) {
			row.terminalAt = req.at;
			row.launchInput = null;
			row.registrationDigest = null;
		}
		this.appendHistory(row, fromState, req.to, row.reasonCode, req.at);
		this.appendEvent(row, req.at);
		return { ...row };
	}

	async listStateHistory(workspaceId: string): Promise<StateHistoryRow[]> {
		return this.history.filter((h) => h.workspaceId === workspaceId).map((h) => ({ ...h }));
	}

	private appendHistory(
		row: WorkspaceRow,
		from: WorkspaceState | null,
		to: WorkspaceState,
		reason: WorkspaceRow["reasonCode"],
		at: Date,
	): void {
		this.history.push({
			id: randomUUID(),
			workspaceId: row.id,
			fromState: from,
			toState: to,
			reasonCode: reason,
			occurredAt: at,
		});
	}

	private appendEvent(row: WorkspaceRow, at: Date): void {
		const payload = buildEventEnvelope(row, at);
		this.outbox.push({
			id: payload.id,
			workspaceId: row.id,
			eventType: payload.type,
			payload,
			occurredAt: at,
			nextAttemptAt: at,
			attemptCount: 0,
			deliveredAt: null,
			lastErrorCode: null,
		});
	}

	// --- Logs ---

	async appendLogs(
		workspaceId: string,
		entries: Array<{ stream: LogRow["stream"]; occurredAt: Date; content: Uint8Array }>,
	): Promise<void> {
		const list = this.logs.get(workspaceId) ?? [];
		let bytes = this.logBytes.get(workspaceId) ?? 0;
		let seq = list.length > 0 ? (list[list.length - 1]?.seq ?? 0) : 0;
		for (const entry of entries) {
			if (bytes + entry.content.length > MAX_LOG_BYTES) {
				break;
			}
			seq += 1;
			bytes += entry.content.length;
			list.push({
				workspaceId,
				seq,
				stream: entry.stream,
				occurredAt: entry.occurredAt,
				content: entry.content,
			});
		}
		this.logs.set(workspaceId, list);
		this.logBytes.set(workspaceId, bytes);
	}

	async readLogs(workspaceId: string, afterSeq: number, limit: number): Promise<LogRow[]> {
		return (this.logs.get(workspaceId) ?? [])
			.filter((l) => l.seq > afterSeq)
			.slice(0, limit)
			.map((l) => ({ ...l }));
	}

	// --- Outbox ---

	async claimDueEvents(now: Date, limit: number): Promise<OutboxRow[]> {
		const due = this.outbox
			.filter((e) => !e.deliveredAt && e.nextAttemptAt <= now && !this.claimedEvents.has(e.id))
			.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
			.slice(0, limit);
		for (const e of due) this.claimedEvents.add(e.id);
		return due.map((e) => ({ ...e }));
	}

	async markEventDelivered(id: string, at: Date): Promise<void> {
		const e = this.outbox.find((x) => x.id === id);
		if (e) {
			e.deliveredAt = at;
			e.attemptCount += 1;
		}
		this.claimedEvents.delete(id);
	}

	async markEventFailed(id: string, errorCode: string, nextAttemptAt: Date): Promise<void> {
		const e = this.outbox.find((x) => x.id === id);
		if (e) {
			e.attemptCount += 1;
			e.lastErrorCode = errorCode;
			e.nextAttemptAt = nextAttemptAt;
		}
		this.claimedEvents.delete(id);
	}
}
