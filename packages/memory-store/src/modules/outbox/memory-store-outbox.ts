import { randomUUID } from "node:crypto";
import type { OutboxRow } from "@pstdio/pocketcoder-runtime-contracts";

import type { MemoryState } from "../../state/memory-store-base";

export class MemoryOutboxStore {
  constructor(private readonly context: Pick<MemoryState, "outbox" | "claimedEvents">) {}
  async claimDueEvents(now: Date, limit: number): Promise<OutboxRow[]> {
    const due = this.context.outbox
      .filter((e) => !e.deliveredAt && e.nextAttemptAt <= now && !this.context.claimedEvents.has(e.id))
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .slice(0, limit);
    for (const e of due) this.context.claimedEvents.add(e.id);
    return due.map((e) => ({ ...e }));
  }

  async markEventDelivered(id: string, at: Date): Promise<void> {
    const e = this.context.outbox.find((x) => x.id === id);
    if (e) {
      e.deliveredAt = at;
      e.attemptCount += 1;
    }
    this.context.claimedEvents.delete(id);
  }

  async markEventFailed(id: string, errorCode: string, nextAttemptAt: Date): Promise<void> {
    const e = this.context.outbox.find((x) => x.id === id);
    if (e) {
      e.attemptCount += 1;
      e.lastErrorCode = errorCode;
      e.nextAttemptAt = nextAttemptAt;
    }
    this.context.claimedEvents.delete(id);
  }

  async appendEvent(workspaceId: string, eventType: string, payload: unknown, at: Date): Promise<void> {
    this.context.outbox.push({
      id: randomUUID(),
      workspaceId,
      eventType,
      payload,
      occurredAt: at,
      nextAttemptAt: at,
      attemptCount: 0,
      deliveredAt: null,
      lastErrorCode: null,
    });
  }
}
