import { PREVIEW_FRAME_BYTES } from "@pstdio/pocketcoder-contracts";

export async function chromiumTarget(signal: AbortSignal) {
  const response = await fetch("http://127.0.0.1:9222/json/list", { signal });
  if (!response.ok || !response.body) throw new Error("Browser discovery failed.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > PREVIEW_FRAME_BYTES) throw new Error("Browser discovery exceeds 64 KiB.");
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const targets = JSON.parse(Buffer.concat(chunks).toString()) as { type: string; webSocketDebuggerUrl: string }[];
  const target = targets.find((entry) => entry.type === "page");
  if (!target) throw new Error("Browser page is missing.");
  const url = new URL(target.webSocketDebuggerUrl);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "9222" ||
    !/^\/devtools\/page\/[\w-]+$/.test(url.pathname)
  )
    throw new Error("Browser debugging endpoint must stay on loopback.");
  return url;
}

export async function openChromiumSocket(socket: WebSocket, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const open = () => {
      cleanup();
      resolve();
    };
    const error = () => {
      cleanup();
      reject(new Error("Browser connection failed."));
    };
    const abort = () => {
      cleanup();
      socket.close();
      reject(new Error("Browser connection cancelled."));
    };
    function cleanup() {
      socket.removeEventListener("open", open);
      socket.removeEventListener("error", error);
      socket.removeEventListener("close", error);
      signal.removeEventListener("abort", abort);
    }
    socket.addEventListener("open", open, { once: true });
    socket.addEventListener("error", error, { once: true });
    socket.addEventListener("close", error, { once: true });
    signal.addEventListener("abort", abort, { once: true });
  });
}
