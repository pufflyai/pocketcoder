import type { PocketCoderClient, TerminalConnection } from "@pstdio/pocketcoder-sdk";
import type { Argv } from "yargs";
import { controlPlaneClient, type Flags, need } from "../../command/cli-context";
import { addAction } from "../command";
import { idOption } from "./options";

const DETACH_ESCAPE = 0x1d;
const DETACH_KEY = "d".charCodeAt(0);

export class TerminalDetachParser {
  private pendingEscape = false;

  push(bytes: Uint8Array): { forward: Uint8Array[]; detached: boolean } {
    const forward: Uint8Array[] = [];
    let pending: number[] = [];
    const flush = () => {
      if (pending.length > 0) forward.push(Uint8Array.from(pending));
      pending = [];
    };
    for (const byte of bytes) {
      if (this.pendingEscape) {
        this.pendingEscape = false;
        if (byte === DETACH_KEY) {
          flush();
          return { forward, detached: true };
        }
        pending.push(DETACH_ESCAPE, byte);
        continue;
      }
      if (byte === DETACH_ESCAPE) {
        flush();
        this.pendingEscape = true;
        continue;
      }
      pending.push(byte);
    }
    flush();
    return { forward, detached: false };
  }
}

export function addTerminalCommand(parser: Argv) {
  return addAction(
    parser,
    "terminal",
    "Open or reattach to an interactive terminal",
    (command) =>
      idOption(command).option("session", {
        type: "string",
        description: "Existing terminal session ID to reattach",
      }),
    async (flags) => {
      process.exitCode = await attachTerminal(flags, controlPlaneClient());
    },
  );
}

// A rejected WebSocket upgrade only surfaces a generic error, so ask the
// capability route first and reuse the server's own explanation. A plain GET
// answers "upgrade required" when the terminal is usable.
export function terminalPreflightIssue(status: number, body: unknown): string | null {
  // 426 is the standard answer when the terminal exists and wants an upgrade.
  if (status === 426 || (status >= 200 && status < 300)) return null;
  const error =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  const message = typeof error?.message === "string" ? error.message : null;
  if (error?.code === "validation.invalid" && message && /upgrade required/i.test(message)) return null;
  return message ?? `terminal request failed with status ${status}`;
}

async function preflightTerminal(client: PocketCoderClient, workspaceId: string): Promise<string | null> {
  try {
    const response = await client.raw(`/v1/workspaces/${encodeURIComponent(workspaceId)}/terminal`);
    const body = await response.json().catch(() => null);
    return terminalPreflightIssue(response.status, body);
  } catch (error) {
    return error instanceof Error ? error.message : "terminal connection failed";
  }
}

async function attachTerminal(flags: Flags, client: PocketCoderClient): Promise<number> {
  const workspaceId = need(flags, "id");
  const failure = await preflightTerminal(client, workspaceId);
  if (failure) {
    console.error(`pcd: ${failure}`);
    return 1;
  }
  const sessionId = typeof flags.session === "string" ? flags.session : undefined;
  const terminal = client.terminals.connect(workspaceId, { sessionId });
  return await bridgeTerminal(terminal);
}

async function bridgeTerminal(terminal: TerminalConnection): Promise<number> {
  const parser = new TerminalDetachParser();
  let activeSessionId: string | undefined;
  let finished = false;
  let rawMode = false;
  const removers: Array<() => void> = [];

  const cleanup = () => {
    for (const remove of removers) remove();
    process.stdin.off("data", onInput);
    process.stdin.off("end", onInputEnd);
    process.off("SIGWINCH", onResize);
    process.off("SIGINT", onInterrupt);
    if (rawMode) process.stdin.setRawMode(false);
    process.stdin.pause();
  };
  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    cleanup();
    resolveResult(code);
  };
  const detach = () => {
    process.stderr.write(
      activeSessionId ? `Detached terminal session ${activeSessionId}\n` : "Detached terminal session\n",
    );
    finish(0);
    terminal.close(1000, "detached");
  };
  function onInput(value: Buffer | string) {
    const parsed = parser.push(typeof value === "string" ? Buffer.from(value) : value);
    for (const chunk of parsed.forward) terminal.sendInput(chunk);
    if (parsed.detached) detach();
  }
  function onInputEnd() {
    detach();
  }
  function onResize() {
    terminal.resize(process.stdout.rows ?? 24, process.stdout.columns ?? 80);
  }
  function onInterrupt() {
    finish(130);
    terminal.close(1000, "interrupted");
  }

  removers.push(
    terminal.onOpen(() => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        rawMode = true;
      }
      process.stdin.resume();
      process.stdin.on("data", onInput);
      process.stdin.on("end", onInputEnd);
      process.on("SIGWINCH", onResize);
      process.on("SIGINT", onInterrupt);
      onResize();
    }),
    terminal.onMessage((message) => {
      if (message.type === "opened") {
        activeSessionId = message.session_id;
        if (message.replay_b64) process.stdout.write(Buffer.from(message.replay_b64, "base64"));
        return;
      }
      if (message.type === "output") {
        process.stdout.write(Buffer.from(message.data_b64, "base64"));
        return;
      }
      if (message.type === "status") {
        process.stderr.write(`Terminal ${message.state}\n`);
        return;
      }
      finish(message.reason === "exit" ? (message.exit_code ?? 0) : 1);
      terminal.close();
    }),
    terminal.onClose(() => finish(1)),
    terminal.onError(() => {
      process.stderr.write("Terminal connection failed. Check that the workspace is ready and the session exists.\n");
      finish(1);
    }),
  );

  return await result;
}
