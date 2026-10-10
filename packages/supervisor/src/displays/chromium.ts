import {
  BROWSER_HEIGHT,
  BROWSER_IMAGE_BYTES,
  BROWSER_WIDTH,
  type BrowserAction,
  PREVIEW_FRAME_BYTES,
} from "@pstdio/pocketcoder-contracts";
import { FramePublisher } from "./frame-publisher";

interface Packet {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message: string };
  method?: string;
  params?: { data?: string; sessionId?: number };
}
const keys: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

export async function connectChromium(frame: (bytes: Uint8Array) => void, closed: () => void) {
  const response = await fetch("http://127.0.0.1:9222/json/list", { signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  if (!response.ok || text.length > PREVIEW_FRAME_BYTES) throw new Error("Browser discovery failed.");
  const targets = JSON.parse(text) as { type: string; webSocketDebuggerUrl: string }[];
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
  const socket = new WebSocket(url);
  const client = new Chromium(socket, frame, closed);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Browser connection timed out."));
    }, 5000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Browser connection failed."));
    };
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        reject(new Error("Browser closed during connection."));
      },
      { once: true },
    );
  });
  try {
    await client.command("Page.enable");
    await client.command("Emulation.setDeviceMetricsOverride", {
      width: BROWSER_WIDTH,
      height: BROWSER_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.command("Page.startScreencast", {
      format: "jpeg",
      quality: 35,
      maxWidth: BROWSER_WIDTH,
      maxHeight: BROWSER_HEIGHT,
    });
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

export class Chromium {
  private sequence = 0;
  private readonly frames: FramePublisher;
  private readonly pending = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly socket: WebSocket,
    frame: (bytes: Uint8Array) => void,
    closed: () => void,
  ) {
    this.frames = new FramePublisher(frame);
    socket.onmessage = (event) => {
      if (
        typeof event.data !== "string" ||
        event.data.length > Math.ceil((BROWSER_IMAGE_BYTES * 4) / 3) + PREVIEW_FRAME_BYTES
      ) {
        this.close();
        return;
      }
      try {
        this.receive(JSON.parse(event.data));
      } catch {
        this.close();
      }
    };
    socket.onclose = () => {
      this.frames.close();
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Browser disconnected."));
      }
      this.pending.clear();
      closed();
    };
  }

  command(method: string, params: Record<string, unknown> = {}) {
    if (this.socket.readyState !== WebSocket.OPEN || this.pending.size >= 64)
      return Promise.reject(new Error("Browser command unavailable."));
    const id = ++this.sequence;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Browser command timed out."));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async action(action: BrowserAction) {
    switch (action.action) {
      case "navigate": {
        const result = await this.command("Page.navigate", { url: action.url });
        if (result.errorText) throw new Error("Browser navigation failed.");
        break;
      }
      case "text":
        await this.command("Input.insertText", { text: action.text });
        break;
      case "click":
        await this.command("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: action.x,
          y: action.y,
          button: "left",
          clickCount: 1,
        });
        await this.command("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: action.x,
          y: action.y,
          button: "left",
          clickCount: 1,
        });
        break;
      case "key":
        await this.command("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: action.key,
          windowsVirtualKeyCode: keys[action.key],
          ...(action.key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
        });
        await this.command("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: action.key,
          windowsVirtualKeyCode: keys[action.key],
        });
        break;
      case "scroll":
        await this.command("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: action.x,
          y: action.y,
          deltaX: 0,
          deltaY: action.deltaY,
        });
        break;
    }
  }

  close() {
    this.frames.close();
    this.socket.close();
  }

  private receive(packet: Packet) {
    if (packet.id !== undefined) {
      const request = this.pending.get(packet.id);
      if (!request) return;
      this.pending.delete(packet.id);
      clearTimeout(request.timer);
      if (packet.error) request.reject(new Error(packet.error.message));
      else request.resolve(packet.result ?? {});
    }
    if (
      packet.method !== "Page.screencastFrame" ||
      typeof packet.params?.sessionId !== "number" ||
      typeof packet.params.data !== "string"
    )
      return;
    // A slow viewer must never hold Chromium's frame acknowledgement or lifecycle traffic.
    void this.command("Page.screencastFrameAck", { sessionId: packet.params.sessionId }).catch(() => this.close());
    const bytes = Buffer.from(packet.params.data, "base64");
    if (bytes.length > BROWSER_IMAGE_BYTES) {
      this.close();
      return;
    }
    this.frames.receive(bytes);
  }
}
