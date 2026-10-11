import { join, resolve } from "node:path";

type Result = Record<string, unknown>;
type Location = { scriptId: string; lineNumber: number; columnNumber?: number };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function lines(stream: ReadableStream<Uint8Array>, receive: (line: string) => void) {
  let pending = "";
  for await (const bytes of stream) {
    pending += new TextDecoder().decode(bytes);
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      receive(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  }
}

export async function wsPurgeChild(config: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--inspect-wait=127.0.0.1:0",
      join(import.meta.dir, "ws-purge-race-child.ts"),
      config,
    ],
    {
      cwd: resolve(import.meta.dir, "../../../.."),
      env: { ...process.env, DOCKER_HOST: `unix://${config}.unreachable.sock` },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const ready = deferred<{ ready: number; pid: number }>();
  const endpoint = deferred<string>();
  const requests = new Map<number, Deferred<Result>>();
  const scripts = new Map<string, string>();
  let diagnostic = "";
  let socket: WebSocket | undefined;
  let sequence = 0;
  let barrier: { location: Location; breakpointId: string; stopped: Deferred<void>; frame?: string } | undefined;
  let closed = false;
  const stdout = lines(child.stdout, (line) => {
    if (!line.startsWith("WS_PURGE_CHILD ")) {
      return;
    }
    const message = JSON.parse(line.slice("WS_PURGE_CHILD ".length));
    if (message.ready) ready.resolve(message);
  });
  const stderr = (async () => {
    for await (const bytes of child.stderr) {
      diagnostic += new TextDecoder().decode(bytes);
      const url = diagnostic.match(/ws:\/\/127\.0\.0\.1:\d+\/\S+/)?.[0];
      if (url) endpoint.resolve(url);
    }
  })();
  const fail = (error: Error) => {
    ready.reject(error);
    endpoint.reject(error);
    barrier?.stopped.reject(error);
    for (const pending of requests.values()) pending.reject(error);
  };
  // Readiness may fail while inspector setup is still in flight; keep its rejection observed.
  void ready.promise.catch(() => {});
  void endpoint.promise.catch(() => {});
  void child.exited.then((code) => {
    if (!closed) fail(new Error(`Socket child exited (${code})`));
  });
  async function close(signal?: "SIGKILL") {
    closed = true;
    if (signal) child.kill(signal);
    else child.stdin.end();
    try {
      const code = await bounded(child.exited, 10_000, "socket child cleanup");
      console.log(
        JSON.stringify({ childClosed: { pid: child.pid, mode: signal ?? "EOF", code, signal: child.signalCode } }),
      );
      if (!signal && code !== 0) throw new Error(`Normal socket child cleanup exited ${code}`);
      if (signal && child.signalCode !== signal) throw new Error("Socket child cleanup did not receive SIGKILL");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        const code = await child.exited;
        console.log(
          JSON.stringify({ childClosed: { pid: child.pid, mode: "forced-SIGKILL", code, signal: child.signalCode } }),
        );
      }
      socket?.close();
      await Promise.all([stdout, stderr]);
      fail(new Error("Socket child closed"));
    }
  }
  try {
    const connection = new WebSocket(await bounded(endpoint.promise, 30_000, "socket inspector"));
    socket = connection;
    await bounded(
      new Promise<void>((resolve, reject) => {
        connection.onopen = () => resolve();
        connection.onerror = () => reject(new Error("Socket inspector connection failed"));
      }),
      10_000,
      "socket inspector connection",
    );
    const send = (method: string, params = {}) => {
      const id = ++sequence;
      const result = deferred<Result>();
      requests.set(id, result);
      connection.send(JSON.stringify({ id, method, params }));
      return bounded(result.promise, 10_000, method);
    };
    connection.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Debugger.scriptParsed") scripts.set(message.params.url, message.params.scriptId);
      if (message.method === "Debugger.paused") {
        const location: Location | undefined = message.params.callFrames[0]?.location;
        if (
          barrier &&
          location?.scriptId === barrier.location.scriptId &&
          location.lineNumber === barrier.location.lineNumber
        ) {
          barrier.frame = message.params.callFrames[0].callFrameId;
          console.log(
            JSON.stringify({ debuggerPaused: location, function: message.params.callFrames[0].functionName }),
          );
          barrier.stopped.resolve();
        } else void send("Debugger.resume").catch(fail);
      }
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
    await send("Debugger.enable");
    await send("Debugger.setBreakpointsActive", { active: true });
    await send("Inspector.initialized");
    const address = await bounded(ready.promise, 30_000, "socket child ready");
    return {
      port: address.ready,
      pid: address.pid,
      async arm(file: string, after: string, statement: string) {
        const script = [...scripts].find(([url]) => url.endsWith(file));
        if (!script) throw new Error(`Socket source not loaded: ${file}`);
        const [url, scriptId] = script;
        const result = await send("Debugger.getScriptSource", { scriptId });
        const source = result.scriptSource as string;
        const start = source.indexOf(after);
        const offset = source.indexOf(statement, start + after.length);
        if (start < 0 || offset < 0) throw new Error(`Socket crash boundary missing: ${file}`);
        const lineNumber = source.slice(0, offset).split("\n").length - 1;
        const installed = await send("Debugger.setBreakpoint", { location: { scriptId, lineNumber } });
        const location = installed.actualLocation as Location;
        if (location.scriptId !== scriptId || location.lineNumber !== lineNumber)
          throw new Error("Inspector moved the socket crash boundary");
        const stopped = deferred<void>();
        barrier = { location, breakpointId: installed.breakpointId as string, stopped };
        console.log(JSON.stringify({ debuggerArmed: { url, location, statement } }));
        return (timeout: number) => bounded(stopped.promise, timeout, "socket durable crash boundary");
      },
      async workspaceId() {
        if (!barrier?.frame) throw new Error("Socket handler is not paused");
        const evaluated = await send("Debugger.evaluateOnCallFrame", {
          callFrameId: barrier.frame,
          expression: "frame.workspace_id",
          returnByValue: true,
        });
        if (evaluated.exceptionDetails) throw new Error("Socket boundary metadata evaluation failed");
        const value = (evaluated.result as { value: unknown }).value;
        if (typeof value !== "string") throw new Error("Socket workspace identity is missing");
        return value;
      },
      async resume() {
        if (!barrier?.frame) throw new Error("Socket is not paused at the owner boundary");
        await send("Debugger.removeBreakpoint", { breakpointId: barrier.breakpointId });
        barrier = undefined;
        await send("Debugger.resume");
      },
      close: () => close(barrier?.frame ? "SIGKILL" : undefined),
    };
  } catch (error) {
    await close("SIGKILL");
    throw error;
  }
}
