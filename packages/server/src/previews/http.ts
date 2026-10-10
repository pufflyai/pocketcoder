import {
  ApiError,
  PREVIEW_FRAME_BYTES,
  type ProxyRequest,
  previewCookies,
  previewRequestHeaders,
  previewResponseHeaders,
} from "@pstdio/pocketcoder-contracts";
import type { Hub } from "../control-channel/hub";
import type { PreviewSession, PreviewSessions } from "./sessions";

async function boundedBody(request: Request, signal: AbortSignal) {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > PREVIEW_FRAME_BYTES) {
        await reader.cancel();
        throw new ApiError("relay.body_too_large", "Preview body exceeds 64 KiB.");
      }
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    return size ? Buffer.concat(chunks).toString("base64") : undefined;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function previewHttp(
  request: Request,
  session: PreviewSession,
  sessions: PreviewSessions,
  hub: Hub,
  release: () => void,
) {
  const url = new URL(request.url);
  const deadline = Math.max(1, Math.min(300_000, session.expires - Date.now()));
  const abort = new AbortController();
  const stop = () => abort.abort();
  const timer = setInterval(() => void sessions.authorize(session).catch(stop), 250);
  timer.unref();
  const timeout = setTimeout(stop, deadline);
  timeout.unref();
  const finish = () => {
    clearInterval(timer);
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", stop);
    release();
  };
  request.signal.addEventListener("abort", stop, { once: true });
  if (request.signal.aborted) stop();
  try {
    const response = await hub.relayStream(
      session.workspaceId,
      {
        service: `pc-preview:${session.name}`,
        method: request.method as ProxyRequest["method"],
        path: url.pathname + url.search,
        query: {},
        headers: previewRequestHeaders(request.headers),
        body_b64: await boundedBody(request, abort.signal),
        deadline_ms: deadline,
      },
      16 * 1024 * 1024,
      abort.signal,
    );
    if (!response.body || response.error_code)
      throw new ApiError("workspace.disconnected", "Preview service is unavailable.");
    const reader = response.body.getReader();
    void reader.closed.then(finish, finish);
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            await sessions.authorize(session);
            const next = await reader.read();
            if (next.done) {
              controller.close();
              finish();
            } else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
            stop();
            finish();
          }
        },
        cancel() {
          stop();
          finish();
        },
      },
      { highWaterMark: 0 },
    );
    const headers = new Headers(previewResponseHeaders(new Headers(response.headers)));
    for (const cookie of previewCookies(new Headers((response.cookies ?? []).map((value) => ["set-cookie", value]))))
      headers.append("set-cookie", cookie);
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    const status = response.status ?? 200;
    if (request.method === "HEAD" || [204, 205, 304].includes(status)) {
      await reader.cancel();
      finish();
      return new Response(null, { status, headers });
    }
    return new Response(body, { status, headers });
  } catch (error) {
    stop();
    finish();
    throw error;
  }
}
