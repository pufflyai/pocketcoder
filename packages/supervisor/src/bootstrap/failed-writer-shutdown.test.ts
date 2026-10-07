// Proves a failed actual attachment writer cannot strand the harness or skip transport closure.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";

async function until(observed: () => boolean | Promise<boolean>, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (!(await observed())) {
    if (performance.now() >= deadline) throw new Error("original observation deadline");
    await Bun.sleep(5);
  }
}

function failedWriterTransport(harness: string, release: string) {
  const id = crypto.randomUUID();
  const phases: string[] = [];
  const logs: string[] = [];
  const state: { send: ((type: string, payload: unknown) => void) | null; closed: boolean } = {
    send: null,
    closed: false,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade", { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        state.send = (type, payload) => {
          ws.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type,
              workspace_id: id,
              connection_id: frame.connection_id,
              seq: 1,
              sent_at: new Date().toISOString(),
              payload,
            }),
          );
        };
        if (frame.type === "registered")
          state.send("registered_ack", {
            epoch: 1,
            reconnect_credential: "synthetic-reconnect",
            limits: { max_frame_bytes: 1048576, max_inflight_relay: 8, log_chunk_bytes: 32768, heartbeat_seconds: 15 },
            exec: {
              setup: [],
              harness: { command: [process.execPath, harness, release], env: {} },
              env: {},
              services: {},
              timeouts: { start: "5s", maxAge: "1h", idle: "1h", disconnectGrace: "2s", terminateGrace: "1s" },
              security: { writable_memory_paths: [] },
              launch_mode: "create",
              source: null,
              restore: null,
              persistence: { mounts: [], conversation_restore: "filesystem_only" },
              checkpoint_hook: null,
              outputs: {},
            },
          });
        if (frame.type === "log_chunk") logs.push(Buffer.from(frame.payload.content_b64, "base64").toString());
        if (frame.type === "termination_ack") phases.push(frame.payload.phase);
      },
      close() {
        state.closed = true;
      },
    },
  });
  return { id, server, phases, logs, state };
}

async function failOriginalWriter(
  root: string,
  state: ReturnType<typeof failedWriterTransport>["state"],
  logs: string[],
) {
  await mkdir(join(root, ".pcd"), { recursive: true });
  await writeFile(join(root, ".pcd", "attachments"), "blocks original mkdir");
  if (!state.send) throw new Error("original registration absent");
  state.send("attachment_start", {
    operation_id: crypto.randomUUID(),
    attachment_id: crypto.randomUUID(),
    name: "failed.txt",
    media_type: "text/plain",
    size_bytes: 0,
  });
  await until(() => logs.some((log) => log.includes("ENOTDIR")));
}

test.each(["shutdown", "term", "kill", "natural"] as const)(
  "%s preserves failed writer while closing remaining lifetime",
  async (control) => {
    const root = await mkdtemp(join(tmpdir(), "failed-writer-"));
    const ready = join(root, "ready");
    const stopped = join(root, "stopped");
    const release = join(root, "release");
    const harness = join(root, "harness.ts");
    const input = join(root, "input.json");
    await writeFile(
      harness,
      `// Uses real termination and a separate finite fallback.
process.once("SIGTERM", async () => { await Bun.write(${JSON.stringify(stopped)}, "term"); process.exit(0); });
await Bun.write(${JSON.stringify(ready)}, String(process.pid));
setTimeout(() => process.exit(37), 5000);
while (!(await Bun.file(process.argv[2]).exists())) await Bun.sleep(5);
process.exit(0);
`,
    );
    const { id, server, state, logs, phases } = failedWriterTransport(harness, release);
    await writeFile(
      input,
      JSON.stringify({
        workspace_id: id,
        server_url: String(server.url),
        registration_secret: "synthetic-registration",
        template_digest: "sha256:failed-writer",
        template_name: "fixture",
        template_version: "1.0.0",
        launch_mode: "create",
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        resolve(import.meta.dir, "../index.ts"),
        "supervise",
        "--launch-input",
        input,
      ],
      { env: { ...process.env, HOME: root }, stdout: "pipe", stderr: "pipe" },
    );
    let terminalCode: number | null = null;
    const terminal = child.exited.then((code) => {
      terminalCode = code;
      return code;
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    let harnessPid: number | null = null;
    try {
      await until(() => Bun.file(ready).exists());
      harnessPid = Number(await Bun.file(ready).text());
      await failOriginalWriter(root, state, logs);
      if (!state.send) throw new Error("original registration absent");
      if (control === "natural") await writeFile(release, "natural-exit");
      else if (control === "shutdown") state.send("shutdown", { reason: "failed_writer" });
      else state.send("signal", { signal: control === "kill" ? "KILL" : "TERM" });
      await until(() => terminalCode !== null, 2000);
      expect(await terminal).not.toBe(0);
      await until(() => state.closed);
      expect(phases).not.toContain("exited");
      expect(logs.some((log) => log.includes("ENOTDIR"))).toBe(true);
      expect(() => process.kill(harnessPid as number, 0)).toThrow();
      if (control === "shutdown" || control === "term") expect(await Bun.file(stopped).exists()).toBe(true);
    } finally {
      await writeFile(release, "cleanup");
      if (terminalCode === null) child.kill("SIGKILL");
      await terminal;
      await output;
      if (harnessPid !== null) {
        try {
          process.kill(harnessPid, "SIGKILL");
        } catch {
          /* Original process already gone. */
        }
        await until(() => {
          try {
            process.kill(harnessPid as number, 0);
            return false;
          } catch {
            return true;
          }
        }, 5500);
      }
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);

test("an exited harness with late original output cannot bypass shutdown grace", async () => {
  const root = await mkdtemp(join(tmpdir(), "late-shutdown-output-"));
  const ready = join(root, "ready");
  const writerReady = join(root, "writer-ready");
  const writer = join(root, "writer.ts");
  const harness = join(root, "harness.ts");
  const input = join(root, "input.json");
  await writeFile(
    writer,
    `// Keeps the original inherited output open past the existing termination grace.\nawait Bun.write(${JSON.stringify(writerReady)}, String(process.pid));\nawait Bun.sleep(1400);\nconsole.log("original-output-settled");\n`,
  );
  await writeFile(
    harness,
    `// Exits zero on TERM while its finite original output writer remains owned by the fixture.\nprocess.once("SIGTERM", async () => {\n  Bun.spawn([process.execPath, ${JSON.stringify(writer)}], { stdout: "inherit", stderr: "inherit" });\n  while (!(await Bun.file(${JSON.stringify(writerReady)}).exists())) await Bun.sleep(5);\n  process.exit(0);\n});\nawait Bun.write(${JSON.stringify(ready)}, "ready");\nsetTimeout(() => process.exit(37), 5000);\n`,
  );
  const { id, server, state, logs, phases } = failedWriterTransport(harness, join(root, "unused-release"));
  await writeFile(
    input,
    JSON.stringify({
      workspace_id: id,
      server_url: String(server.url),
      registration_secret: "synthetic-registration",
      template_digest: "sha256:late-output",
      template_name: "fixture",
      template_version: "1.0.0",
      launch_mode: "create",
    }),
  );
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", resolve(import.meta.dir, "../index.ts"), "supervise", "--launch-input", input],
    { env: { ...process.env, HOME: root }, stdout: "pipe", stderr: "pipe" },
  );
  let code: number | null = null;
  const terminal = child.exited.then((result) => {
    code = result;
    return result;
  });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    await until(() => Bun.file(ready).exists());
    if (!state.send) throw new Error("original registration absent");
    state.send("shutdown", { reason: "late_original_output" });
    await until(() => code !== null, 3000);
    expect(await terminal).not.toBe(0);
    expect(phases).toContain("killed");
    expect(phases).not.toContain("exited");
    expect(logs.some((log) => log.includes("original-output-settled"))).toBe(true);
    expect(state.closed).toBe(true);
  } finally {
    if (code === null) child.kill("SIGKILL");
    await terminal;
    await output;
    if (await Bun.file(writerReady).exists()) {
      const pid = Number(await Bun.file(writerReady).text());
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Original writer already settled. */
      }
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 5500);
    }
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
