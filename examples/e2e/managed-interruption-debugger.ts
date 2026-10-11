import { join } from "node:path";
import { ROOT } from "./kubernetes-cluster";

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

export async function managerChild(config: string, kubeconfig: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--inspect-wait=127.0.0.1:0",
      join(import.meta.dir, "managed-interruption-child.ts"),
      config,
    ],
    { cwd: ROOT, env: { ...process.env, KUBECONFIG: kubeconfig }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const ready = deferred<{ ready: string; pid: number }>();
  const endpoint = deferred<string>();
  const commands = new Map<number, Deferred<void>>();
  const requests = new Map<number, Deferred<Result>>();
  const scripts = new Map<string, string>();
  let diagnostic = "";
  let socket: WebSocket | undefined;
  let sequence = 0;
  let barrier: { location: Location; stopped: Deferred<void> } | undefined;
  let closed = false;
  const stdout = lines(child.stdout, (line) => {
    if (!line.startsWith("MANAGER_CHILD ")) {
      if (line) console.log(line);
      return;
    }
    const message = JSON.parse(line.slice("MANAGER_CHILD ".length));
    if (message.ready) ready.resolve(message);
    const command = commands.get(message.id);
    if (!command) return;
    commands.delete(message.id);
    if (message.error) command.reject(new Error(message.error));
    else command.resolve();
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
    for (const pending of commands.values()) pending.reject(error);
    for (const pending of requests.values()) pending.reject(error);
  };
  // Readiness may fail while inspector setup is still in flight; keep its rejection observed.
  void ready.promise.catch(() => {});
  void endpoint.promise.catch(() => {});
  void child.exited.then((code) => {
    if (!closed) fail(new Error(`Manager child exited (${code}): ${diagnostic}`));
  });
  async function close(signal?: "SIGKILL") {
    closed = true;
    if (signal) child.kill(signal);
    else child.stdin.end();
    try {
      await bounded(child.exited, 10_000, "manager child cleanup");
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      socket?.close();
      await Promise.all([stdout, stderr]);
      fail(new Error("Manager child closed"));
    }
  }
  try {
    const connection = new WebSocket(await bounded(endpoint.promise, 30_000, "manager inspector"));
    socket = connection;
    await bounded(
      new Promise<void>((resolve, reject) => {
        connection.onopen = () => resolve();
        connection.onerror = () => reject(new Error("Manager inspector connection failed"));
      }),
      10_000,
      "manager inspector connection",
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
    const address = await bounded(ready.promise, 30_000, "manager child ready");
    return {
      url: address.ready,
      pid: address.pid,
      reconcile() {
        const id = ++sequence;
        const result = deferred<void>();
        commands.set(id, result);
        child.stdin.write(`${JSON.stringify({ id })}\n`);
        return result.promise;
      },
      async arm(file: string, after: string, statement: string) {
        const script = [...scripts].find(([url]) => url.endsWith(file));
        if (!script) throw new Error(`Manager source not loaded: ${file}`);
        const [url, scriptId] = script;
        const result = await send("Debugger.getScriptSource", { scriptId });
        const source = result.scriptSource as string;
        const start = source.indexOf(after);
        const offset = source.indexOf(statement, start + after.length);
        if (start < 0 || offset < 0) throw new Error(`Manager crash boundary missing: ${file}`);
        const lineNumber = source.slice(0, offset).split("\n").length - 1;
        const installed = await send("Debugger.setBreakpoint", { location: { scriptId, lineNumber } });
        const location = installed.actualLocation as Location;
        if (location.scriptId !== scriptId || location.lineNumber !== lineNumber)
          throw new Error("Inspector moved the manager crash boundary");
        const stopped = deferred<void>();
        barrier = { location, stopped };
        console.log(JSON.stringify({ debuggerArmed: { url, location, statement } }));
        return (timeout: number) => bounded(stopped.promise, timeout, "manager durable crash boundary");
      },
      async kill() {
        await close("SIGKILL");
        if (child.signalCode !== "SIGKILL") throw new Error("Manager child was not killed by SIGKILL");
        console.log(JSON.stringify({ killedManager: address.pid, signal: child.signalCode }));
      },
      close: () => close(),
    };
  } catch (error) {
    await close("SIGKILL");
    throw error;
  }
}
