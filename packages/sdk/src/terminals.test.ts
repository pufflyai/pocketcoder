import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PocketCoderClient } from "./index";

class FakeSocket extends EventTarget {
  readonly sent: string[] = [];
  readyState = WebSocket.OPEN;

  send(value: string) {
    this.sent.push(value);
  }

  close() {}
}

describe("terminal client", () => {
  test("opens an authenticated WebSocket and sends bounded input and resize messages", () => {
    const socket = new FakeSocket();
    let opened: { url: string; headers: Record<string, string> } | undefined;
    const client = new PocketCoderClient({
      baseUrl: "https://pocketcoder.test/",
      apiKey: "pkt_terminal",
      webSocket: (url, headers) => {
        opened = { url, headers };
        return socket as unknown as WebSocket;
      },
    });
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    const terminal = client.terminals.connect(workspaceId, { sessionId });

    expect(opened).toEqual({
      url: `wss://pocketcoder.test/v1/workspaces/${workspaceId}/terminal?session=${sessionId}`,
      headers: { authorization: "Bearer pkt_terminal" },
    });
    terminal.sendInput(Buffer.alloc(32 * 1024 + 1, 1));
    terminal.resize(40, 120);
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({ type: "input" }),
      expect.objectContaining({ type: "input" }),
      { type: "resize", rows: 40, cols: 120 },
    ]);
    expect(Buffer.from(JSON.parse(socket.sent[0] ?? "{}").data_b64, "base64")).toHaveLength(
      32 * 1024,
    );
  });

  test("validates server messages before delivering them", () => {
    const socket = new FakeSocket();
    const client = new PocketCoderClient({
      baseUrl: "http://pocketcoder.test",
      apiKey: "pkt_terminal",
      webSocket: () => socket as unknown as WebSocket,
    });
    const messages: unknown[] = [];
    const terminal = client.terminals.connect(randomUUID());
    terminal.onMessage((message) => messages.push(message));

    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "opened", session_id: randomUUID() }),
      }),
    );
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "wat" }) }));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "opened" });
  });

  test("delivers early close and error events without reviving removed open listeners", async () => {
    const socket = new FakeSocket();
    const client = new PocketCoderClient({
      baseUrl: "http://pocketcoder.test",
      apiKey: "pkt_terminal",
      webSocket: () => socket as unknown as WebSocket,
    });
    const terminal = client.terminals.connect(randomUUID());
    let opens = 0;
    const removeOpen = terminal.onOpen(() => {
      opens += 1;
    });
    removeOpen();
    socket.dispatchEvent(new CloseEvent("close"));
    socket.dispatchEvent(new Event("error"));
    let closes = 0;
    let errors = 0;
    terminal.onClose(() => {
      closes += 1;
    });
    terminal.onError(() => {
      errors += 1;
    });

    await Promise.resolve();

    expect({ opens, closes, errors }).toEqual({ opens: 0, closes: 1, errors: 1 });
  });
});
