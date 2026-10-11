import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../..");
const fixture = join(import.meta.dir, "off-node-crash-fixture.ts");

export function crashProcess(input: unknown, inspect = false) {
  const flags = inspect ? ["--inspect-wait=127.0.0.1:0"] : [];
  return Bun.spawn([process.execPath, "--no-env-file", ...flags, fixture, JSON.stringify(input)], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function killWhen(child: ReturnType<typeof crashProcess>, observed: () => Promise<boolean>) {
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  const deadline = Date.now() + 30_000;
  try {
    while (!(await observed())) {
      if (exited) throw new Error(`Child exited before the crash barrier: ${await new Response(child.stderr).text()}`);
      if (Date.now() > deadline) throw new Error("Crash barrier timed out.");
      await Bun.sleep(1);
    }
    child.kill("SIGSTOP");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}

// The debugger stops real code after its durable write, without changing filesystem or provider results.
export async function pauseBefore(input: unknown, file: string, after: string, statement: string) {
  const child = crashProcess(input, true);
  let inspector: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stderr.getReader();
    let diagnostic = "";
    while (!diagnostic.match(/ws:\/\/127\.0\.0\.1:\d+\/\S+/)) {
      const result = await reader.read();
      if (result.done) throw new Error(`Inspector did not start: ${diagnostic}`);
      diagnostic += new TextDecoder().decode(result.value);
    }
    const url = diagnostic.match(/ws:\/\/127\.0\.0\.1:\d+\/\S+/)?.[0] as string;
    const stderr = (async () => {
      let remaining = "";
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        remaining += new TextDecoder().decode(result.value);
      }
      reader.releaseLock();
      return remaining;
    })();
    inspector = new WebSocket(url);
    const connection = inspector;
    await new Promise<void>((resolve, reject) => {
      connection.onopen = () => resolve();
      connection.onerror = reject;
    });
    let id = 0;
    const requests = new Map<
      number,
      { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
    >();
    let scriptId: string;
    let lineNumber: number;
    let paused!: () => void;
    let failed!: (error: Error) => void;
    const stopped = new Promise<void>((resolve, reject) => {
      paused = resolve;
      failed = reject;
    });
    connection.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Debugger.scriptParsed" && message.params.url.endsWith(file)) {
        scriptId = message.params.scriptId;
        void send("Debugger.getScriptSource", { scriptId })
          .then(async (result) => {
            const source = result.scriptSource as string;
            const start = source.indexOf(after);
            const offset = source.indexOf(statement, start + after.length);
            if (start < 0 || offset < 0) throw new Error("Crash cleanup location is missing.");
            lineNumber = source.slice(0, offset).split("\n").length - 1;
            await send("Debugger.setBreakpoint", { location: { scriptId, lineNumber } });
          })
          .catch(failed);
      }
      if (message.method === "Debugger.paused") {
        const frame = message.params.callFrames[0];
        if (frame?.location.scriptId === scriptId && frame.location.lineNumber === lineNumber) {
          console.log(`Real debugger crash barrier: ${file}, before ${statement}`);
          paused();
        } else connection.send(JSON.stringify({ id: ++id, method: "Debugger.resume" }));
      }
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
    const send = (method: string, params = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const request = ++id;
        requests.set(request, { resolve, reject });
        connection.send(JSON.stringify({ id: request, method, params }));
      });
    await send("Debugger.enable");
    await send("Debugger.setBreakpointsActive", { active: true });
    await send("Inspector.initialized");
    timer = setTimeout(() => failed(new Error("Debugger crash barrier timed out.")), 30_000);
    await Promise.race([
      stopped,
      child.exited.then(async () => {
        throw new Error(`Child exited before its durable crash barrier: ${diagnostic}${await stderr}`);
      }),
    ]);
    clearTimeout(timer);
    return {
      child,
      async kill() {
        child.kill("SIGKILL");
        await child.exited;
        connection.close();
        await stderr;
      },
    };
  } catch (error) {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
    inspector?.close();
    throw error;
  }
}
