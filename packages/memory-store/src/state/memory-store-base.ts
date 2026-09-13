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
  type TerminalSessionRow,
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

export class MemoryState {
  templates: TemplateRow[] = [];

  principals: PrincipalRow[] = [];

  keys: MachineKeyRow[] = [];

  workspaces = new Map<string, WorkspaceRow>();

  warmPoolRuntimes = new Map<string, WarmPoolRuntimeRow>();

  history: StateHistoryRow[] = [];

  outbox: OutboxRow[] = [];

  logs = new Map<string, LogRow[]>();

  networkEvents = new Map<string, NetworkEventRow[]>();

  terminalSessions = new Map<string, TerminalSessionRow>();

  logBytes = new Map<string, number>();

  claimedEvents = new Set<string>();

  storage = new Map<string, WorkspaceStorageRow>();

  checkpoints = new Map<string, WorkspaceCheckpointRow>();

  operations = new Map<string, WorkspaceOperationRow>();

  outputs = new Map<string, WorkspaceOutputRow[]>();

  conversations = new Map<string, ConversationMessageRow[]>();

  conversationBytes = new Map<string, number>();

  conversationStates = new Map<string, ConversationStateRow>();

  changeWaiters = new Map<string, Set<() => void>>();

  coordinatorActive = false;

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

  notifyWorkspaceChange(id: string): void {
    const waiters = this.changeWaiters.get(id);
    if (!waiters) return;
    this.changeWaiters.delete(id);
    for (const resolve of waiters) resolve();
  }

  appendHistory(
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

  appendWorkspaceEvent(row: WorkspaceRow, at: Date): void {
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
}
