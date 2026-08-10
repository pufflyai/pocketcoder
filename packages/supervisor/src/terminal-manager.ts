import type {
  AgentFrame,
  ExecSpec,
  TerminalClose,
  TerminalInput,
  TerminalOpen,
  TerminalResize,
} from "@pstdio/pocketcoder-contracts";
import { TERMINAL_CHUNK_BYTES } from "@pstdio/pocketcoder-contracts";
import { enforcedEnvironment } from "./supervisor-utils";

type SendFrame = (type: AgentFrame["type"], payload: unknown) => boolean;
type Process = ReturnType<typeof Bun.spawn>;
type CloseReason = "idle" | "checkpoint" | "workspace_ended" | "closed";

interface ActiveTerminal {
  id: string;
  process: Process;
  terminal: NonNullable<Process["terminal"]>;
  replay: Uint8Array;
  outputQueue: Uint8Array[];
  queuedBytes: number;
  outputTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout>;
  closeReason: CloseReason | null;
  exitCode: number | null;
  done: Promise<void>;
  resolveDone: () => void;
}

export class TerminalManager {
  private readonly sessions = new Map<string, ActiveTerminal>();

  constructor(
    private readonly exec: () => ExecSpec | null,
    private readonly send: SendFrame,
  ) {}

  get activeCount() {
    return this.sessions.size;
  }

  open(request: TerminalOpen): void {
    const exec = this.exec();
    const spec = exec?.terminal;
    if (!exec || !spec) {
      this.refuse(request.session_id, "terminal capability is not declared");
      return;
    }
    const existing = this.sessions.get(request.session_id);
    if (existing) {
      if (!request.reattach) {
        this.refuse(request.session_id, "terminal session already exists");
        return;
      }
      existing.terminal.resize(request.cols, request.rows);
      this.send("terminal_opened", {
        session_id: request.session_id,
        ...(existing.replay.byteLength > 0
          ? { replay_b64: Buffer.from(existing.replay).toString("base64") }
          : {}),
      });
      return;
    }
    if (request.reattach) {
      this.refuse(request.session_id, "terminal session does not exist");
      return;
    }
    if (this.sessions.size >= spec.max_sessions) {
      this.refuse(request.session_id, "terminal session limit reached");
      return;
    }

    const pending: Uint8Array[] = [];
    let session: ActiveTerminal | undefined;
    let process: Process;
    try {
      process = Bun.spawn(spec.command, {
        cwd: spec.cwd,
        env: enforcedEnvironment(exec, { ...spec.env, TERM: "xterm-256color" }),
        terminal: {
          cols: request.cols,
          rows: request.rows,
          name: "xterm-256color",
          data: (_terminal, data) => {
            if (session) this.handleOutput(session, data);
            else pending.push(data.slice());
          },
        },
      });
    } catch {
      this.refuse(request.session_id, "terminal command could not start");
      return;
    }
    if (!process.terminal) throw new Error("Bun did not allocate a terminal");
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    session = {
      id: request.session_id,
      process,
      terminal: process.terminal,
      replay: new Uint8Array(),
      outputQueue: [],
      queuedBytes: 0,
      outputTimer: null,
      idleTimer: this.idleTimer(request.session_id, spec.idle_timeout_seconds),
      closeReason: null,
      exitCode: null,
      done,
      resolveDone,
    };
    this.sessions.set(request.session_id, session);
    this.send("terminal_opened", { session_id: request.session_id });
    for (const chunk of pending) this.handleOutput(session, chunk);
    void process.exited.then((code) => this.finish(session as ActiveTerminal, code));
  }

  input(request: TerminalInput): void {
    const session = this.sessions.get(request.session_id);
    const spec = this.exec()?.terminal;
    if (!session || !spec) return;
    session.terminal.write(Buffer.from(request.data_b64, "base64"));
    clearTimeout(session.idleTimer);
    session.idleTimer = this.idleTimer(session.id, spec.idle_timeout_seconds);
  }

  resize(request: TerminalResize): void {
    this.sessions.get(request.session_id)?.terminal.resize(request.cols, request.rows);
  }

  async close(request: TerminalClose): Promise<void> {
    await this.closeSession(request.session_id, request.reason);
  }

  async closeAll(reason: Exclude<CloseReason, "idle" | "closed">): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id, reason)));
  }

  private async closeSession(id: string, reason: CloseReason): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.closeReason = reason;
    clearTimeout(session.idleTimer);
    session.terminal.close();
    session.process.kill("SIGTERM");
    await Promise.race([session.process.exited, Bun.sleep(50)]);
    if (this.sessions.get(id) === session) session.process.kill("SIGKILL");
    await session.process.exited;
    await session.done;
  }

  private handleOutput(session: ActiveTerminal, data: Uint8Array): void {
    if (this.sessions.get(session.id) !== session) return;
    const replayLimit = this.exec()?.terminal?.replay_buffer_bytes ?? 0;
    const combined = Buffer.concat([session.replay, data]);
    session.replay = combined.subarray(Math.max(0, combined.byteLength - replayLimit));
    for (let offset = 0; offset < data.byteLength; offset += TERMINAL_CHUNK_BYTES) {
      const chunk = data.subarray(offset, offset + TERMINAL_CHUNK_BYTES).slice();
      session.outputQueue.push(chunk);
      session.queuedBytes += chunk.byteLength;
    }
    while (session.queuedBytes > replayLimit && session.outputQueue.length > 1) {
      session.queuedBytes -= session.outputQueue.shift()?.byteLength ?? 0;
    }
    this.scheduleOutput(session);
  }

  private finish(session: ActiveTerminal, exitCode: number): void {
    if (this.sessions.get(session.id) !== session) return;
    clearTimeout(session.idleTimer);
    try {
      session.terminal.close();
    } catch {
      // The explicit close path already released the PTY.
    }
    session.exitCode = exitCode;
    if (session.outputQueue.length > 0) {
      this.scheduleOutput(session);
      return;
    }
    this.finalize(session);
  }

  private scheduleOutput(session: ActiveTerminal): void {
    if (session.outputTimer) return;
    session.outputTimer = setTimeout(() => this.drainOutput(session), 0);
  }

  private drainOutput(session: ActiveTerminal): void {
    session.outputTimer = null;
    if (this.sessions.get(session.id) !== session) return;
    const chunk = session.outputQueue.shift();
    if (chunk) {
      session.queuedBytes -= chunk.byteLength;
      this.send("terminal_output", {
        session_id: session.id,
        data_b64: Buffer.from(chunk).toString("base64"),
      });
    }
    if (session.outputQueue.length > 0) {
      this.scheduleOutput(session);
      return;
    }
    if (session.exitCode !== null) this.finalize(session);
  }

  private finalize(session: ActiveTerminal): void {
    this.sessions.delete(session.id);
    this.send("terminal_closed", {
      session_id: session.id,
      reason: session.closeReason ?? "exit",
      exit_code: session.exitCode,
    });
    session.resolveDone();
  }

  private idleTimer(sessionId: string, seconds: number) {
    return setTimeout(() => void this.closeSession(sessionId, "idle"), seconds * 1000);
  }

  private refuse(sessionId: string, detail: string): void {
    this.send("terminal_closed", { session_id: sessionId, reason: "error", detail });
  }
}
