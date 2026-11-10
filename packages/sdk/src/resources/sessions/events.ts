import { type ErrorCode, managed } from "@pstdio/pocketcoder-contracts";
import { PocketCoderError } from "../../transport/errors";
import type { PocketCoderTransport } from "../../transport/transport";

export interface SessionEventOptions {
  // The `eventCursor` of a history page, or the cursor of the last event you applied.
  after?: string;
  signal?: AbortSignal;
  // Reopen the stream after the last delivered cursor when the connection ends. Default true.
  reconnect?: boolean;
}

interface Frame {
  id: string | null;
  event: string | null;
  data: string;
}

async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end).split("\n");
      buffer = buffer.slice(end + 2);
      const field = (name: string) =>
        block
          .find((line) => line.startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim();
      const data = block
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      yield { id: field("id") ?? null, event: field("event") ?? null, data };
      end = buffer.indexOf("\n\n");
    }
  }
}

// Durable session events, delivered at least once. Apply each event idempotently by its resource
// revision and keep `event.cursor`; after a disconnect the stream resumes from that cursor.
// An expired or foreign cursor throws `events.cursor_expired` / `events.cursor_invalid`: read a new
// history snapshot and resume after its `eventCursor`.
export async function* sessionEvents(
  transport: PocketCoderTransport,
  sessionId: string,
  options: SessionEventOptions = {},
): AsyncGenerator<managed.RuntimeEvent> {
  let cursor = options.after ?? null;
  do {
    const query = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
    const response = await transport.stream(
      `/v1/sessions/${encodeURIComponent(sessionId)}/events${query}`,
      options.signal,
      cursor ? { "last-event-id": cursor } : {},
    );
    if (!response.body) return;
    for await (const frame of frames(response.body)) {
      if (frame.event === "keepalive") continue;
      if (frame.event === "error") {
        // Authority was revoked or retention ended while the stream was open.
        const { code } = JSON.parse(frame.data) as { code: ErrorCode };
        throw new PocketCoderError({ message: `Session event stream ended: ${code}`, code, status: 0 });
      }
      const event = managed.RuntimeEventSchema.parse(JSON.parse(frame.data));
      cursor = event.cursor;
      yield event;
    }
  } while (options.reconnect !== false && !options.signal?.aborted);
}
