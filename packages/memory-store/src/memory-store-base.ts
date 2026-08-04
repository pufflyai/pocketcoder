import { randomUUID } from "node:crypto";
import type { WorkspaceState } from "@pstdio/pocketcoder-contracts";
import {
	buildEventEnvelope,
	type ConversationMessageRow,
	type ConversationStateRow,
	type LogRow,
	type MachineKeyRow,
	type NetworkEventRow,
	type OutboxRow,
	type PrincipalRow,
	type StateHistoryRow,
	type TemplateRow,
	type WarmPoolRuntimeRow,
	type WorkspaceCheckpointRow,
	type WorkspaceOperationRow,
	type WorkspaceOutputRow,
	type WorkspaceRow,
	type WorkspaceStorageRow,
} from "@pstdio/pocketcoder-runtime-contracts";

// In-memory adapter for tests and single-process development. PostgreSQL is
// the durable implementation; both satisfy the same behavioral contract.

export const ACTIVE_STATES: readonly WorkspaceState[] = [
	"provisioning",
	"connected",
	"ready",
	"preserving",
	"terminating",
];
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const MAX_CONVERSATION_BYTES = 50 * 1024 * 1024;
export const MAX_CONVERSATION_MESSAGES = 100_000;
export const CHANGE_PATCH_KEYS = new Set([
	"connectedAt",
	"disconnectedAt",
	"health",
	"agentState",
	"failureLogTail",
	"failureLogTailTruncated",
	"failureLastLogSeq",
	"resolvedSource",
	"persistenceCapability",
	"latestCheckpointId",
	"outputs",
]);

export class MemoryStoreBase {
	protected templates: TemplateRow[] = [];
	protected principals: PrincipalRow[] = [];
	protected keys: MachineKeyRow[] = [];
	protected workspaces = new Map<string, WorkspaceRow>();
	protected warmPoolRuntimes = new Map<string, WarmPoolRuntimeRow>();
	protected history: StateHistoryRow[] = [];
	protected outbox: OutboxRow[] = [];
	protected logs = new Map<string, LogRow[]>();
	protected networkEvents = new Map<string, NetworkEventRow[]>();
	protected logBytes = new Map<string, number>();
	protected claimedEvents = new Set<string>();
	protected storage = new Map<string, WorkspaceStorageRow>();
	protected checkpoints = new Map<string, WorkspaceCheckpointRow>();
	protected operations = new Map<string, WorkspaceOperationRow>();
	protected outputs = new Map<string, WorkspaceOutputRow[]>();
	protected conversations = new Map<string, ConversationMessageRow[]>();
	protected conversationBytes = new Map<string, number>();
	protected conversationStates = new Map<string, ConversationStateRow>();
	protected changeWaiters = new Map<string, Set<() => void>>();
	protected coordinatorActive = false;

	async init(): Promise<void> {}
	async acquireCoordinatorLease(): Promise<() => Promise<void>> {
		if (this.coordinatorActive) throw new Error("a PocketCoder coordinator is already active");
		this.coordinatorActive = true;
		return async () => {
			this.coordinatorActive = false;
		};
	}
	async close(): Promise<void> {
		this.coordinatorActive = false;
		for (const waiters of this.changeWaiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.changeWaiters.clear();
	}

	protected notifyWorkspaceChange(id: string): void {
		const waiters = this.changeWaiters.get(id);
		if (!waiters) return;
		this.changeWaiters.delete(id);
		for (const resolve of waiters) resolve();
	}

	// --- Templates ---

	protected appendHistory(
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

	protected appendWorkspaceEvent(row: WorkspaceRow, at: Date): void {
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
}
