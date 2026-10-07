// Proves actual supervisor shutdown joins setup before acknowledging termination.
import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@pstdio/pocketcoder-contracts";

function registeredExec(setup: string, harness: string) {
  return {
    setup: [
      { name: "held-setup", command: [process.execPath, setup], env: {}, timeoutSeconds: 4 },
      { name: "late-setup", command: [process.execPath, harness], env: {}, timeoutSeconds: 4 },
    ],
    harness: { command: [process.execPath, harness], env: {} },
    env: {},
    services: {},
    timeouts: { start: "5s", maxAge: "1h", idle: "1h", disconnectGrace: "2s", terminateGrace: "2s" },
    security: { writable_memory_paths: [] },
    launch_mode: "create",
    source: null,
    restore: null,
    persistence: { mounts: [], conversation_restore: "filesystem_only" },
    checkpoint_hook: null,
    outputs: {},
  };
}

async function waitFile(path: string) {
  const deadline = performance.now() + 3000;
  while (!(await Bun.file(path).exists())) {
    if (performance.now() >= deadline) throw new Error("setup did not start");
    await Bun.sleep(5);
  }
}

function shutdownTransport(exec: ReturnType<typeof registeredExec>, lateAttachment: string) {
  const workspaceId = crypto.randomUUID();
  const phases: string[] = [];
  const controls: {
    shutdown: (() => void) | null;
    lateAttachment: (() => void) | null;
    send: ((type: string, payload: unknown) => void) | null;
  } = { shutdown: null, lateAttachment: null, send: null };
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
        const send = (type: string, payload: unknown) =>
          ws.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type,
              workspace_id: workspaceId,
              connection_id: frame.connection_id,
              seq: 1,
              sent_at: new Date().toISOString(),
              payload,
            }),
          );
        if (frame.type === "registered") {
          controls.send = send;
          controls.shutdown = () => {
            send("shutdown", { reason: "test" });
          };
          controls.lateAttachment = () => {
            send("attachment_start", {
              operation_id: crypto.randomUUID(),
              attachment_id: lateAttachment,
              name: "late.txt",
              media_type: "text/plain",
              size_bytes: 0,
            });
          };
          send("registered_ack", {
            epoch: 1,
            reconnect_credential: "synthetic-reconnect",
            limits: { max_frame_bytes: 1048576, max_inflight_relay: 8, log_chunk_bytes: 32768, heartbeat_seconds: 15 },
            exec,
          });
        }
        if (frame.type === "termination_ack") phases.push(frame.payload.phase);
      },
    },
  });
  return { server, workspaceId, phases, controls };
}

test("shutdown joins admitted setup and refuses a later harness launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "setup-shutdown-"));
  const ready = join(root, "ready");
  const release = join(root, "release");
  const completed = join(root, "completed");
  const launched = join(root, "launched");
  const setup = join(root, "setup.ts");
  const harness = join(root, "harness.ts");
  const input = join(root, "input.json");
  const lateAttachment = crypto.randomUUID();
  const { server, workspaceId, phases, controls } = shutdownTransport(registeredExec(setup, harness), lateAttachment);
  await writeFile(
    setup,
    `await Bun.write(${JSON.stringify(ready)}, "ready"); while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(5); await Bun.write(${JSON.stringify(completed)}, "done");`,
  );
  await writeFile(harness, `await Bun.write(${JSON.stringify(launched)}, "launched");`);
  await writeFile(
    input,
    JSON.stringify({
      workspace_id: workspaceId,
      server_url: String(server.url),
      registration_secret: "synthetic-registration",
      template_digest: "sha256:setup-shutdown",
      template_name: "fixture",
      template_version: "1.0.0",
      launch_mode: "create",
    }),
  );
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", resolve(import.meta.dir, "../index.ts"), "supervise", "--launch-input", input],
    { env: { ...process.env, HOME: root }, stdout: "pipe", stderr: "pipe" },
  );
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    await waitFile(ready);
    if (!controls.shutdown) throw new Error("registration absent");
    controls.shutdown();
    await Bun.sleep(100);
    expect(phases).not.toContain("exited");
    expect(child.exitCode).toBeNull();
    if (!controls.lateAttachment) throw new Error("registration absent");
    controls.lateAttachment();
    await Bun.sleep(25);
    expect(
      await stat(join(root, ".pcd", "attachments", lateAttachment)).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await writeFile(release, "release");
    expect(await child.exited).toBe(0);
    expect(await Bun.file(completed).exists()).toBe(true);
    expect(await Bun.file(launched).exists()).toBe(false);
    expect(phases).toContain("exited");
  } finally {
    await writeFile(release, "release");
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await output;
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

function attachmentWriterBarrier(input: string, ready: string, release: string) {
  const entry = resolve(import.meta.dir, "../supervisor.ts");
  return `// Holds one actual original FileHandle write until the owning test releases it.
import { open } from "node:fs/promises";
import { supervise } from ${JSON.stringify(entry)};
const probe = await open(${JSON.stringify(`${input}.probe`)}, "w");
const prototype = Object.getPrototypeOf(probe);
const original = prototype.write;
await probe.close();
prototype.write = async function (...args) {
  if (Buffer.isBuffer(args[0]) && args[0].toString() === "held-attachment") {
    await Bun.write(${JSON.stringify(ready)}, "original-write-admitted");
    while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(5);
  }
  return await Reflect.apply(original, this, args);
};
try { process.exitCode = await supervise(${JSON.stringify(input)}); }
finally { prototype.write = original; }
`;
}

test.each(["shutdown", "kill"] as const)(
  "%s joins an admitted attachment write before acknowledging exit",
  async (control) => {
    const root = await mkdtemp(join(tmpdir(), "attachment-shutdown-"));
    const release = join(root, "release");
    const ready = join(root, "write-ready");
    const harnessReady = join(root, "harness-ready");
    const harness = join(root, "harness.ts");
    const input = join(root, "input.json");
    const wrapper = join(root, "original-writer.ts");
    const attachment = crypto.randomUUID();
    const operation = crypto.randomUUID();
    const exec = { ...registeredExec(harness, harness), setup: [] };
    const { server, workspaceId, phases, controls } = shutdownTransport(exec, crypto.randomUUID());
    await writeFile(
      harness,
      `process.once("SIGTERM", () => process.exit(0)); await Bun.write(${JSON.stringify(harnessReady)}, "ready"); setInterval(() => {}, 1000);`,
    );
    await writeFile(
      input,
      JSON.stringify({
        workspace_id: workspaceId,
        server_url: String(server.url),
        registration_secret: "synthetic-registration",
        template_digest: "sha256:attachment-shutdown",
        template_name: "fixture",
        template_version: "1.0.0",
        launch_mode: "create",
      }),
    );
    await writeFile(wrapper, attachmentWriterBarrier(input, ready, release));
    const child = Bun.spawn([process.execPath, "--no-env-file", wrapper], {
      env: { ...process.env, HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    try {
      await waitFile(harnessReady);
      if (!controls.send || !controls.shutdown) throw new Error("registration absent");
      controls.send("attachment_start", {
        operation_id: operation,
        attachment_id: attachment,
        name: "payload.txt",
        media_type: "text/plain",
        size_bytes: 15,
      });
      controls.send("attachment_chunk", {
        operation_id: operation,
        seq: 0,
        content_b64: Buffer.from("held-attachment").toString("base64"),
      });
      await waitFile(ready);
      if (control === "kill") controls.send("signal", { signal: "KILL" });
      else controls.shutdown();
      await Bun.sleep(100);
      expect(phases).not.toContain("exited");
      expect(child.exitCode).toBeNull();
      await writeFile(release, "release");
      expect(await child.exited).toBe(control === "kill" ? 137 : 0);
      const payload = join(root, ".pcd", "attachments", attachment, `.payload.tmp-${operation}`);
      expect(await Bun.file(payload).text()).toBe("held-attachment");
      expect(phases).toContain("exited");
    } finally {
      await writeFile(release, "release");
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await output;
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  10000,
);
