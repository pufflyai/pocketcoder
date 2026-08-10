import { randomUUID } from "node:crypto";
import type { OutboxRow } from "@pstdio/pocketcoder-runtime-contracts";
import { MemoryTerminalStore } from "./memory-store-terminals";

export class MemoryOutboxStore extends MemoryTerminalStore {
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

  async appendEvent(
    workspaceId: string,
    eventType: string,
    payload: unknown,
    at: Date,
  ): Promise<void> {
    this.outbox.push({
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
