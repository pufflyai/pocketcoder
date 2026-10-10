import { createHash } from "node:crypto";
import { type BrowserAction, BrowserFrames } from "@pstdio/pocketcoder-contracts";
import { waitFor } from "./local-process";

export async function connectBrowser(baseUrl: string, origin: URL, cookie: string) {
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/socket`, {
    headers: { host: origin.host, origin: origin.origin, cookie },
  } as unknown as string[]);
  socket.binaryType = "arraybuffer";
  const frames: { hash: string; at: number; bytes: number }[] = [];
  const assembly = new BrowserFrames();
  const closed = new Promise<void>((resolve) => {
    socket.onclose = () => resolve();
  });
  socket.onmessage = (event) => {
    const bytes = assembly.receive(new Uint8Array(event.data as ArrayBuffer));
    if (!bytes) return;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Invalid browser frame.");
    frames.push({ hash: createHash("sha256").update(bytes).digest("hex"), at: Date.now(), bytes: bytes.length });
    if (frames.length > 1000) throw new Error("Demo frame budget exceeded.");
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("Browser socket rejected."));
  });
  const send = (action: BrowserAction) => socket.send(new TextEncoder().encode(JSON.stringify(action)));
  async function capture(previous?: string) {
    await waitFor(async () => Boolean(frames.at(-1)) && frames.at(-1)?.hash !== previous, 10_000, "browser frame");
    return frames.at(-1)?.hash;
  }
  return { socket, closed, send, capture, frames };
}
