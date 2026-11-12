import { randomUUID } from "node:crypto";
import type { managed, PocketCoderClient } from "@pstdio/pocketcoder-sdk";

export interface BusinessAuthorization {
  canUse(userId: string, sessionId: string): boolean;
}
export class ManagedRuntimeConsumer {
  constructor(
    private readonly client: PocketCoderClient,
    private readonly authorization: BusinessAuthorization,
  ) {}
  private allow(userId: string, sessionId: string) {
    if (!this.authorization.canUse(userId, sessionId)) throw new Error("Not authorized for this session.");
  }
  startSession(profile: string, owner: string, sessionId = randomUUID(), group = owner) {
    return this.client.sessions.create({ sessionId, profile, owner, group });
  }
  async attach(
    userId: string,
    sessionId: string,
    file: { inputId: string; name: string; mediaType: string; bytes: Uint8Array },
  ) {
    this.allow(userId, sessionId);
    return (await this.client.sessions.upload(sessionId, file)).reference;
  }
  async ask(
    userId: string,
    sessionId: string,
    message: string,
    options: { attachments?: string[]; requestId?: string } = {},
  ) {
    this.allow(userId, sessionId);
    return this.client.requests.submit(sessionId, {
      requestId: options.requestId ?? randomUUID(),
      message,
      attachments: options.attachments ?? [],
    });
  }
  cancel(userId: string, sessionId: string) {
    this.allow(userId, sessionId);
    return this.client.sessions.cancel(sessionId);
  }
  close(userId: string, sessionId: string) {
    this.allow(userId, sessionId);
    return this.client.sessions.close(sessionId);
  }
  transcript(userId: string, sessionId: string, after?: string) {
    this.allow(userId, sessionId);
    return this.client.sessions.conversation(sessionId, { after });
  }
  async waitFor(userId: string, sessionId: string, requestId: string, signal?: AbortSignal) {
    this.allow(userId, sessionId);
    let after: string | undefined, current: managed.Request | undefined;
    while (true) {
      signal?.throwIfAborted();
      const feed = await this.client.sessions.conversation(sessionId, { after }, { signal });
      after = feed.cursor;
      if (feed.reset) current = undefined;
      current = feed.requests.find((r) => r.requestId === requestId) ?? current;
      if (current?.state === "terminal" && current.collection.state === "settled")
        return {
          request: current,
          collection: current.collection,
          exports: (await this.client.files.exports(sessionId, requestId)).items,
        };
      await Bun.sleep(100);
    }
  }
}
