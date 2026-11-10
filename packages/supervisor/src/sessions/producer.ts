import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConversationFact,
  type ConversationMessageInput,
  ConversationMessageInputSchema,
  type ConversationPart,
  type ConversationRequestIdentity,
  ConversationRequestIdentitySchema,
  canonicalJson,
  digestOf,
  ProducerObservationSchema,
  type WorkloadAcceptance,
  WorkloadAcceptanceSchema,
  type WorkloadExecutionReference,
  WorkloadExecutionReferenceSchema,
} from "@pstdio/pocketcoder-contracts";

export interface SessionRun {
  acceptance: WorkloadAcceptance;
  identity: ConversationRequestIdentity;
  inputDirectory?: string;
  signal: AbortSignal;
  emit(key: string, role: ConversationMessageInput["role"], parts: ConversationPart[], fact?: ConversationFact): void;
}
export type SessionRunner = (run: SessionRun) => Promise<"canceled" | void>;
type Snapshot = Exclude<ReturnType<typeof ProducerObservationSchema.parse>, { phase: "absent" }>;
interface Entry {
  snapshot: Snapshot;
  identity: ConversationRequestIdentity | null;
  keys: string[];
}

// This is the physical producer journal. The controller remains the request owner.
// Atomic snapshots make lookup and accept replay the same messages after a lost reply.
export class SessionProducer {
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private accepting = true;

  constructor(
    private readonly directory: string,
    private readonly runner: SessionRunner,
    private readonly onMessage?: (message: ConversationMessageInput) => void,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  async accept(raw: { acceptance: unknown; conversationIdentity: unknown; inputDirectory?: string }) {
    const acceptance = WorkloadAcceptanceSchema.parse(raw.acceptance);
    const identity = ConversationRequestIdentitySchema.parse(raw.conversationIdentity);
    const execution = acceptance.execution;
    if (
      execution.owner !== "conversation-request" ||
      execution.requestId !== identity.turn_id ||
      acceptance.operation !== "message" ||
      typeof acceptance.input.message !== "string"
    )
      throw new Error("Invalid session request");
    const key = this.key(execution);
    const existing = this.load(execution);
    if (existing) {
      this.match(existing, acceptance.fingerprint);
      if (existing.identity && canonicalJson(existing.identity) !== canonicalJson(identity))
        throw new Error("Request identity conflict");
      return structuredClone(existing.snapshot);
    }
    if (!this.accepting) throw new Error("Session producer is quiescing");
    // One runner owns a conversation at a time. Different conversations may run independently.
    for (const activeKey of this.active.keys())
      if (this.entries.get(activeKey)?.identity?.conversation_id === identity.conversation_id)
        throw new Error("Conversation already has an active request");
    const entry: Entry = {
      identity,
      keys: [],
      snapshot: { execution, fingerprint: acceptance.fingerprint, phase: "accepted", outcome: null, messages: [] },
    };
    const abort = new AbortController();
    const run: SessionRun = {
      acceptance,
      identity,
      inputDirectory: raw.inputDirectory,
      signal: abort.signal,
      emit: (id, role, parts, fact) => this.emit(entry, id, role, parts, fact),
    };
    this.emit(entry, "user", "user", [
      { type: "text", text: acceptance.input.message },
      ...acceptance.inputs.objects.map((file) => ({
        type: "file" as const,
        file_id: file.fileId,
        name: file.name,
        media_type: file.mediaType,
        size_bytes: file.sizeBytes,
      })),
    ]);
    this.entries.set(key, entry);
    const done = Promise.resolve().then(async () => {
      entry.snapshot.phase = "running";
      this.save(entry);
      try {
        const result = await this.runner(run);
        this.finish(entry, abort.signal.aborted || result === "canceled" ? "canceled" : "completed");
      } catch (error) {
        if (!abort.signal.aborted)
          this.emit(entry, "error", "assistant", [
            {
              type: "error",
              code: "provider_error",
              message: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
            },
          ]);
        this.finish(entry, abort.signal.aborted ? "canceled" : "failed");
      } finally {
        this.active.delete(key);
      }
    });
    this.active.set(key, { abort, done });
    return structuredClone(entry.snapshot);
  }

  async lookup(execution: WorkloadExecutionReference) {
    return structuredClone(this.load(execution)?.snapshot ?? { execution, phase: "absent" as const });
  }

  async cancel(execution: WorkloadExecutionReference, fingerprint: string) {
    let entry = this.load(execution);
    if (!entry) {
      entry = {
        identity: null,
        keys: [],
        snapshot: {
          execution,
          fingerprint,
          phase: "canceled",
          outcome: { status: "canceled", finalResponse: null },
          messages: [],
        },
      };
      this.entries.set(this.key(execution), entry);
      this.save(entry);
    }
    this.match(entry, fingerprint);
    const active = this.active.get(this.key(execution));
    active?.abort.abort();
    await active?.done;
    return structuredClone(entry.snapshot);
  }

  async ack(execution: WorkloadExecutionReference, fingerprint: string) {
    const entry = this.require(execution, fingerprint);
    if (!["terminal", "canceled"].includes(entry.snapshot.phase)) throw new Error("Execution is still running");
    return structuredClone(entry.snapshot);
  }

  async quiesce() {
    this.accepting = false;
    await Promise.all([...this.active.values()].map(({ done }) => done));
  }

  async shutdown() {
    this.accepting = false;
    for (const { abort } of this.active.values()) abort.abort();
    await Promise.all([...this.active.values()].map(({ done }) => done));
  }

  private key(execution: WorkloadExecutionReference) {
    return canonicalJson(WorkloadExecutionReferenceSchema.parse(execution));
  }
  private path(execution: WorkloadExecutionReference) {
    const key = digestOf(execution).slice(7);
    return join(this.directory, `${key}.json`);
  }
  private save(entry: Entry) {
    const path = this.path(entry.snapshot.execution);
    writeFileSync(`${path}.tmp`, JSON.stringify(entry), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  private load(execution: WorkloadExecutionReference) {
    const key = this.key(execution);
    const cached = this.entries.get(key);
    if (cached) return cached;
    let raw: string;
    try {
      raw = readFileSync(this.path(execution), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const saved = JSON.parse(raw) as Entry;
    const snapshot = ProducerObservationSchema.parse(saved.snapshot);
    if (snapshot.phase === "absent") throw new Error("Invalid journal entry");
    const entry = {
      snapshot,
      identity: saved.identity ? ConversationRequestIdentitySchema.parse(saved.identity) : null,
      keys: saved.keys,
    };
    this.entries.set(key, entry);
    // Never rerun an accepted ID when the previous process died without a terminal fact.
    if (!["terminal", "canceled"].includes(snapshot.phase)) this.finish(entry, "lost");
    return entry;
  }
  private match(entry: Entry, fingerprint: string) {
    if (entry.snapshot.fingerprint !== fingerprint) throw new Error("Request fingerprint conflict");
  }
  private require(execution: WorkloadExecutionReference, fingerprint: string) {
    const entry = this.load(execution);
    if (!entry) throw new Error("Execution not found");
    this.match(entry, fingerprint);
    return entry;
  }
  private emit(
    entry: Entry,
    key: string,
    role: ConversationMessageInput["role"],
    parts: ConversationPart[],
    fact?: ConversationFact,
  ) {
    if (!entry.identity) throw new Error("Message has no accepted identity");
    let sequence = entry.keys.indexOf(key);
    const added = sequence < 0;
    if (added) sequence = entry.keys.length;
    entry.snapshot.messages ??= [];
    const messages = entry.snapshot.messages;
    const previous = messages[sequence];
    const messageId = previous?.message_id ?? crypto.randomUUID();
    const message = ConversationMessageInputSchema.parse({
      message_id: messageId,
      role,
      parts,
      content: parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      occurred_at: previous?.occurred_at ?? new Date().toISOString(),
      metadata: {},
      identity: {
        ...entry.identity,
        event_id: previous?.identity?.event_id ?? crypto.randomUUID(),
        message_id: messageId,
        sequence,
        revision: (previous?.identity?.revision ?? 0) + 1,
        ...(fact ? { fact } : {}),
      },
    });
    const candidate = [...messages];
    candidate[sequence] = message;
    if (
      key !== "error" &&
      key !== "terminal" &&
      (candidate.length > 1000 || finalizedBytes(candidate) > 4 * 1024 * 1024 - 32 * 1024)
    )
      throw new Error("Session output limit exceeded");
    if (added) entry.keys.push(key);
    messages[sequence] = message;
    this.save(entry);
    this.onMessage?.(message);
  }
  private finish(entry: Entry, status: "completed" | "failed" | "canceled" | "lost") {
    for (const [index, message] of (entry.snapshot.messages ?? []).entries()) {
      if (!message.parts?.some((part) => part.type === "tool" && ["running", "pending"].includes(part.status)))
        continue;
      const parts = message.parts.map((part) =>
        part.type === "tool" && ["running", "pending"].includes(part.status)
          ? {
              ...part,
              status: status === "canceled" ? ("canceled" as const) : ("failed" as const),
              ended_at: new Date().toISOString(),
            }
          : part,
      );
      this.emit(entry, entry.keys[index]!, message.role, parts, message.identity?.fact);
    }
    const response = entry.snapshot.messages?.findLast((message) => message.identity?.fact?.type === "final_response");
    entry.snapshot.phase = status === "canceled" ? "canceled" : "terminal";
    entry.snapshot.outcome = { status, finalResponse: response?.content ?? null };
    this.emit(entry, "terminal", "system", [], { type: "turn_terminal", outcome: status });
  }
}

function finalizedBytes(messages: ConversationMessageInput[]) {
  return Buffer.byteLength(
    JSON.stringify(
      messages.map((message) => ({
        ...message,
        identity: message.identity
          ? { ...message.identity, revision: message.identity.revision + 1 }
          : message.identity,
        parts: message.parts?.map((part) =>
          part.type === "tool" && ["running", "pending"].includes(part.status)
            ? { ...part, status: "completed", ended_at: part.ended_at ?? "2000-01-01T00:00:00.000Z" }
            : part,
        ),
      })),
    ),
  );
}
