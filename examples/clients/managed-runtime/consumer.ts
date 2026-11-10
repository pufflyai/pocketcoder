import { randomUUID } from "node:crypto";
import { type managed, type PocketCoderClient, PocketCoderError } from "@pstdio/pocketcoder-sdk";
import type { IntentFile } from "./intents";

// The application's own authorization. PocketCoder never sees users or roles; it only sees the
// opaque session IDs this consumer decides a user may use.
export interface BusinessAuthorization {
  canUse(userId: string, sessionId: string): boolean;
}

export interface TurnResult {
  request: managed.Request;
  collection: managed.CollectionResult;
  exports: managed.ExportObject[];
}

const settled = (request: managed.Request) => request.state === "terminal" && request.collection.state === "settled";

// A headless reference consumer that uses only the public SDK. It keeps session and request IDs
// and nothing else: no runtime supervisor, no rebinding loop, no fingerprint assembly, no
// provider verification and no usage ledger. PocketCoder owns all of that behind the session.
export class ManagedRuntimeConsumer {
  constructor(
    private readonly client: PocketCoderClient,
    private readonly intents: IntentFile,
    private readonly authorization: BusinessAuthorization,
  ) {}

  private allow(userId: string, sessionId: string) {
    if (!this.authorization.canUse(userId, sessionId)) throw new Error("Not authorized for this session.");
  }

  async startSession(profile: { profileId: string; revision: number }, sessionId: string = randomUUID()) {
    return this.client.sessions.create({ sessionId, profileId: profile.profileId, profileRevision: profile.revision });
  }

  async attach(userId: string, sessionId: string, file: { name: string; mediaType: string; bytes: Uint8Array }) {
    this.allow(userId, sessionId);
    const input = await this.client.files.put(sessionId, { inputId: randomUUID(), ...file });
    return input.reference;
  }

  // Persists the exact body first, then sends it. Re-running after any failure resends the same
  // body; the server answers with the original request instead of running it twice.
  async ask(
    userId: string,
    sessionId: string,
    message: string,
    options: { attachments?: managed.InputReference[]; deadlineMs?: number; requestId?: string } = {},
  ) {
    this.allow(userId, sessionId);
    const known = options.requestId ? this.intents.get(options.requestId) : undefined;
    const body = known?.body ?? {
      requestId: options.requestId ?? randomUUID(),
      message,
      attachments: options.attachments ?? [],
      dispatchDeadline: new Date(Date.now() + (options.deadlineMs ?? 10 * 60_000)).toISOString(),
    };
    if (!known) await this.intents.save({ userId, sessionId, body });
    return this.client.requests.submit(sessionId, body);
  }

  // After a restart, resend every intent the consumer recorded. Accepted ones replay unchanged.
  async resend(sessionId: string) {
    const replies = [];
    for (const intent of this.intents.pending(sessionId))
      replies.push(await this.client.requests.submit(sessionId, intent.body));
    return replies;
  }

  // Reads the current history, then follows events after its watermark until the request has a
  // terminal outcome and a settled collection. A lost stream resumes from the last cursor; an
  // expired cursor starts again from a fresh history snapshot.
  async waitFor(userId: string, sessionId: string, requestId: string, signal?: AbortSignal): Promise<TurnResult> {
    this.allow(userId, sessionId);
    while (true) {
      const current = await this.client.requests.get(sessionId, requestId);
      if (settled(current)) return this.result(sessionId, current);
      const { eventCursor } = await this.client.sessions.snapshot(sessionId);
      try {
        for await (const event of this.client.sessions.events(sessionId, { after: eventCursor, signal })) {
          if (event.kind === "request.updated" && event.requestId === requestId && settled(event.data))
            return this.result(sessionId, event.data);
        }
        if (signal?.aborted) throw signal.reason;
      } catch (error) {
        if (!(error instanceof PocketCoderError) || error.code !== "events.cursor_expired") throw error;
      }
    }
  }

  async cancel(userId: string, sessionId: string, requestId: string, cancelId: string = randomUUID()) {
    this.allow(userId, sessionId);
    return this.client.requests.cancel(sessionId, requestId, { cancelId });
  }

  async close(userId: string, sessionId: string, cancelId: string = randomUUID()) {
    this.allow(userId, sessionId);
    return this.client.sessions.close(sessionId, { cancelId });
  }

  async transcript(userId: string, sessionId: string) {
    this.allow(userId, sessionId);
    return (await this.client.sessions.snapshot(sessionId)).records;
  }

  private async result(sessionId: string, request: managed.Request): Promise<TurnResult> {
    const collection = await this.client.requests.collection(sessionId, request.requestId);
    const exports = (await this.client.files.exports(sessionId, request.requestId)).items;
    return { request, collection, exports };
  }
}
