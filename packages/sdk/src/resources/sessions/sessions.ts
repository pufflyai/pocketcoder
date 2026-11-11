import {
  ConversationLiveEventSchema,
  managed,
  PreviewOpenResponseSchema,
  type ViewSessionOptions,
} from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { queryString } from "../../transport/common";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";
import { type SessionEventOptions, sessionEvents } from "./events";

export function sessionPath(sessionId: string) {
  return `/v1/sessions/${encodeURIComponent(sessionId)}`;
}

// A stop receipt. `state` is "pending" until the stop has evidence; retry with the same cancelId.
export type StopReceipt = managed.CancelReceipt;

export interface SessionPreviewOptions extends RequestOptions {
  session?: ViewSessionOptions;
  // Required for cloud view sessions. Use a new grant id after a replacement conflict.
  grant?: { id: string; subject: string; accessRevision: string; ceilingAt: string };
}

const SessionPreviewSchema = PreviewOpenResponseSchema.extend({ grantId: z.uuid().nullable() });

// Logical sessions. Applications keep only session and request IDs; the controller places,
// replaces and stops compute itself.
export class SessionsApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  // Creating again with the same body after a lost reply returns the same session.
  create(input: managed.SessionCreate, options: RequestOptions = {}) {
    return this.transport.request("/v1/sessions", managed.SessionSchema, {
      ...options,
      method: "POST",
      body: JSON.stringify(managed.SessionCreateSchema.parse(input)),
    });
  }

  get(sessionId: string, options: RequestOptions = {}) {
    return this.transport.request(sessionPath(sessionId), managed.SessionSchema, options);
  }

  // Records a wish for compute. It never names or reuses a physical workspace.
  resume(sessionId: string, options: RequestOptions = {}) {
    return this.transport.request(`${sessionPath(sessionId)}/resume`, managed.SessionSchema, {
      ...options,
      method: "POST",
    });
  }

  close(sessionId: string, command: managed.CancelCommand, options: RequestOptions = {}) {
    return this.transport.request(`${sessionPath(sessionId)}/close`, managed.CancelReceiptSchema, {
      ...options,
      method: "POST",
      body: JSON.stringify(managed.CancelCommandSchema.parse(command)),
    });
  }

  // One page of the retained canonical records. Every page of one snapshot carries the same
  // `eventCursor`; pass it to `events` to see everything that committed later.
  history(sessionId: string, query: { cursor?: string; limit?: number } = {}, options: RequestOptions = {}) {
    return this.transport.request(
      `${sessionPath(sessionId)}/history?${queryString({ cursor: query.cursor, limit: query.limit ?? 50 })}`,
      managed.ManagedHistoryPageSchema,
      options,
    );
  }

  // Every record of the current snapshot plus the event cursor to subscribe after.
  async snapshot(sessionId: string, options: RequestOptions = {}) {
    const records: managed.HistoryPage["records"] = [];
    let cursor: string | undefined;
    let eventCursor = "";
    do {
      const page = await this.history(sessionId, { cursor, limit: 200 }, options);
      records.push(...page.records);
      eventCursor = page.eventCursor;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { records, eventCursor };
  }

  events(sessionId: string, options: SessionEventOptions = {}) {
    return sessionEvents(this.transport, sessionId, options);
  }

  // Open turns are snapshots; use history and its durable cursor for committed replay.
  open(sessionId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `${sessionPath(sessionId)}/conversation/open`,
      z.object({ turns: z.array(ConversationLiveEventSchema) }),
      options,
    );
  }

  // Opens a preview of the session's current compute. A 409 operation.conflict means compute was
  // replaced during the open; retry, with a new grant id for cloud sessions.
  openPreview(sessionId: string, name: string, options: SessionPreviewOptions = {}) {
    return this.transport.request(
      `${sessionPath(sessionId)}/previews/${encodeURIComponent(name)}`,
      SessionPreviewSchema,
      {
        method: "POST",
        body: JSON.stringify({
          session: options.session ?? { mode: "local" },
          ...(options.grant ? { grant: options.grant } : {}),
        }),
        signal: options.signal,
      },
    );
  }
}
