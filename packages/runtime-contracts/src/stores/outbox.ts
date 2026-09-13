export interface OutboxRow {
  id: string;
  workspaceId: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date;
  nextAttemptAt: Date;
  attemptCount: number;
  deliveredAt: Date | null;
  lastErrorCode: string | null;
}

export interface OutboxStore {
  claimDueEvents(now: Date, limit: number): Promise<OutboxRow[]>;
  markEventDelivered(id: string, at: Date): Promise<void>;
  markEventFailed(id: string, errorCode: string, nextAttemptAt: Date): Promise<void>;
  appendEvent(workspaceId: string, eventType: string, payload: unknown, at: Date): Promise<void>;
}
