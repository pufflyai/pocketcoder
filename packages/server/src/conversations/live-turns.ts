import {
  type ConversationLiveEvent,
  type ConversationMessageIdentity,
  type ConversationMessageInput,
  type ConversationRequestIdentity,
  ConversationRequestIdentitySchema,
} from "@pstdio/pocketcoder-contracts";
import type { ConversationTurnCommit, Store } from "@pstdio/pocketcoder-runtime-core";

type IdentifiedMessage = ConversationMessageInput & { identity: ConversationMessageIdentity };

interface OpenTurn {
  workspaceId: string;
  request: ConversationRequestIdentity;
  startedAt: Date;
  // The latest revision of each event, in the order events first arrived.
  events: Map<string, IdentifiedMessage>;
}

type Listener = (event: ConversationLiveEvent) => void;

// The live turn is served from memory and the event stream; only the finished turn is written.
// A controller restart loses open turns, and startup records them as interrupted.
export class LiveTurns {
  private readonly turns = new Map<string, OpenTurn>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(private readonly store: Pick<Store, "isAcceptedTurn" | "commitConversationTurn">) {}

  // Frames of one turn are applied in arrival order, even while an earlier one awaits the store.
  receive(workspaceId: string, message: IdentifiedMessage) {
    const key = `${workspaceId}:${message.identity.conversation_id}:${message.identity.turn_id}`;
    const previous = this.queue.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.apply(key, workspaceId, message));
    this.queue.set(key, next);
    const settle = () => {
      if (this.queue.get(key) === next) this.queue.delete(key);
    };
    next.then(settle, settle);
    return next;
  }

  workspaces() {
    return new Set([...this.turns.values()].map((turn) => turn.workspaceId));
  }

  open(workspaceId: string) {
    return [...this.turns.values()].filter((turn) => turn.workspaceId === workspaceId).map(snapshot);
  }

  subscribe(workspaceId: string, listener: Listener) {
    const listeners = this.listeners.get(workspaceId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(workspaceId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(workspaceId);
    };
  }

  // A workspace that ends with a turn still open never sends its terminal fact.
  async close(workspaceId: string, at: Date) {
    for (const [key, turn] of this.turns)
      if (turn.workspaceId === workspaceId) await this.commit(key, turn, "interrupted", "workspace_ended", at);
  }

  private async apply(key: string, workspaceId: string, message: IdentifiedMessage) {
    let turn = this.turns.get(key);
    if (!turn) {
      const request = ConversationRequestIdentitySchema.parse(message.identity);
      if (!(await this.store.isAcceptedTurn(workspaceId, request)))
        throw new Error("conversation.request_not_accepted");
      turn = { workspaceId, request, startedAt: new Date(message.occurred_at), events: new Map() };
      this.turns.set(key, turn);
    }
    const current = turn.events.get(message.identity.event_id);
    if (current && current.identity.revision >= message.identity.revision) return;
    turn.events.set(message.identity.event_id, message);
    this.emit(workspaceId, snapshot(turn));
    const fact = message.identity.fact;
    if (fact?.type === "turn_terminal")
      await this.commit(key, turn, fact.outcome, fact.reason ?? null, new Date(message.occurred_at));
  }

  private async commit(
    key: string,
    turn: OpenTurn,
    status: ConversationTurnCommit["status"],
    reason: string | null,
    at: Date,
  ) {
    this.turns.delete(key);
    const { record } = await this.store.commitConversationTurn({
      workspaceId: turn.workspaceId,
      identity: turn.request,
      status,
      reason,
      messages: ordered(turn).map((message) => ({
        messageId: message.message_id,
        role: message.role,
        content: message.content,
        occurredAt: new Date(message.occurred_at),
        metadata: message.metadata,
        identity: message.identity,
      })),
      startedAt: turn.startedAt,
      endedAt: at,
    });
    this.emit(turn.workspaceId, {
      type: "committed",
      conversation_id: turn.request.conversation_id,
      turn_id: turn.request.turn_id,
      status: record.status,
      last_seq: record.lastSeq,
    });
  }

  private emit(workspaceId: string, event: ConversationLiveEvent) {
    for (const listener of this.listeners.get(workspaceId) ?? []) listener(event);
  }
}

// Producers number events within a turn; arrival order breaks ties.
function ordered(turn: OpenTurn) {
  return [...turn.events.values()].sort((a, b) => a.identity.sequence - b.identity.sequence);
}

function snapshot(turn: OpenTurn): Extract<ConversationLiveEvent, { type: "turn" }> {
  return {
    type: "turn",
    conversation_id: turn.request.conversation_id,
    turn_id: turn.request.turn_id,
    messages: ordered(turn).map(({ message_id, role, content, occurred_at, metadata, identity }) => ({
      message_id,
      role,
      content,
      occurred_at,
      metadata,
      identity,
    })),
  };
}

// Open turns lived in the previous process; record them before producers reconnect.
export async function recordInterruptedTurns(
  store: Pick<Store, "recordInterruptedTurns">,
  log: (line: string) => void,
) {
  const interrupted = await store.recordInterruptedTurns(new Date());
  if (interrupted) log(`conversations: recorded ${interrupted} interrupted turns`);
}
