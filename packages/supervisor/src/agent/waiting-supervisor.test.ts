import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AgentFrame,
  type ExecSpec,
  type FiniteProcessFact,
  type PersistenceMount,
  PROTOCOL_VERSION,
  parseWorkloadTemplate,
  type ServerFrame,
  waitingExecSpec,
  workloadSnapshotOf,
} from "@pstdio/pocketcoder-contracts";

async function fixture(command: string[], configure?: (exec: ExecSpec, root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-waiting-")));
  const workspaceId = randomUUID();
  const execution = {
    workspaceId,
    incarnationId: "observed-container",
    owner: "process" as const,
    requestId: randomUUID(),
  };
  const template = await Bun.file(
    resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json"),
  ).json();
  template.spec.adapters.main.command = command;
  template.spec.network = { mode: "unrestricted" };
  const exec = waitingExecSpec(workloadSnapshotOf(parseWorkloadTemplate(template)), execution.incarnationId, "create");
  await configure?.(exec, root);
  const frames: AgentFrame[] = [];
  let socket: { send(raw: string): unknown; close(): void } | null = null;
  let connectionId = "";
  let seq = 0;
  let registrations = 0;
  const send = (type: ServerFrame["type"], payload: unknown) =>
    socket?.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        workspace_id: workspaceId,
        connection_id: connectionId,
        seq: ++seq,
        sent_at: new Date().toISOString(),
        type,
        payload,
      }),
    );
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as AgentFrame;
        frames.push(frame);
        socket = ws;
        connectionId = frame.connection_id;
        if (frame.type === "registered") {
          registrations++;
          send("registered_ack", {
            epoch: registrations,
            reconnect_credential: "memory-only",
            limits: { max_frame_bytes: 1048576, max_inflight_relay: 8, log_chunk_bytes: 65536, heartbeat_seconds: 15 },
            exec,
          });
        }
      },
    },
  });
  const inputPath = join(root, "input.json");
  await Bun.write(
    inputPath,
    JSON.stringify({
      workspace_id: workspaceId,
      server_url: `http://127.0.0.1:${server.port}`,
      registration_secret: "single-use",
      template_name: template.metadata.name,
      template_version: "1.0.0",
      template_digest: `sha256:${"a".repeat(64)}`,
      launch_mode: "create",
    }),
  );
  const child = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../index.ts"), "supervise", "--launch-input", inputPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(frames)}`);
      await Bun.sleep(10);
    }
  };
  return {
    root,
    frames,
    execution,
    child,
    send,
    waitFor,
    disconnect: () => socket?.close(),
    get registrations() {
      return registrations;
    },
    async close() {
      child.kill("SIGKILL");
      await child.exited;
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

const facts = (frames: AgentFrame[]) =>
  frames
    .filter((frame): frame is Extract<AgentFrame, { type: "finite_process" }> => frame.type === "finite_process")
    .map((frame) => frame.payload);

test.each([0, 7])("supervisor waits, explicitly runs exit %s, reconnects and retains the result", async (code) => {
  const f = await fixture([process.execPath, "-e", `process.exit(${code})`]);
  try {
    await f.waitFor(() => f.frames.some((frame) => frame.type === "runtime_ready"));
    expect(facts(f.frames)).toEqual([]);
    const start = { execution: f.execution, fingerprint: `sha256:${"a".repeat(64)}`, operation: "run" };
    f.send("process_start", start);
    await f.waitFor(() => facts(f.frames).some((fact) => fact.phase === "exited"));
    const terminal = facts(f.frames).at(-1) as FiniteProcessFact;
    expect(terminal).toMatchObject({ phase: "exited", exitCode: code, signal: null });
    expect(f.child.exitCode).toBeNull();
    const count = f.frames.length;
    f.disconnect();
    await f.waitFor(
      () => f.registrations === 2 && f.frames.slice(count).some((frame) => frame.type === "finite_process"),
    );
    f.send("process_start", start);
    f.send("process_lookup", { execution: f.execution });
    await f.waitFor(() => facts(f.frames).length >= 5);
    expect(facts(f.frames).filter((fact) => fact.phase === "running")).toHaveLength(1);
    expect(facts(f.frames).at(-1)).toEqual(terminal);
    f.send("shutdown", { reason: "finished-finalization" });
    expect(await f.child.exited).toBe(0);
  } finally {
    await f.close();
  }
});

test("supervisor cancels the exact long-running process without exiting", async () => {
  const f = await fixture([process.execPath, "-e", "setInterval(()=>{},1000)"]);
  try {
    await f.waitFor(() => f.frames.some((frame) => frame.type === "runtime_ready"));
    f.send("process_start", { execution: f.execution, fingerprint: `sha256:${"a".repeat(64)}`, operation: "run" });
    await f.waitFor(() => facts(f.frames).some((fact) => fact.phase === "running"));
    f.send("process_cancel", {
      execution: f.execution,
      signal: "SIGTERM",
      cancelId: randomUUID(),
      deadlineAt: new Date(Date.now() + 1000).toISOString(),
    });
    await f.waitFor(() => facts(f.frames).some((fact) => fact.phase === "exited"));
    expect(facts(f.frames).at(-1)).toMatchObject({ exitCode: null, signal: "SIGTERM" });
    expect(f.child.exitCode).toBeNull();
  } finally {
    f.send("shutdown", { reason: "test-cleanup" });
    await f.child.exited;
    await f.close();
  }
});

test("waiting readiness stays behind setup and source revocation acknowledgment", async () => {
  const f = await fixture([process.execPath, "-e", "process.exit(0)"], async (exec, root) => {
    for (const args of [
      ["init", root],
      [
        "-C",
        root,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ],
    ]) {
      const child = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "ignore" });
      expect(await child.exited).toBe(0);
    }
    exec.source = {
      kind: "git",
      repository: "fixture",
      revision: "HEAD",
      url: "https://fixture.invalid/source.git",
      destination: root,
      credential: "workspace-scoped-fixture",
      credential_expires_at: new Date(Date.now() + 4000).toISOString(),
    };
    exec.setup = [
      {
        name: "barrier",
        timeoutSeconds: 4,
        command: [
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(join(root, "setup"))}, 'started'); while (!(await Bun.file(${JSON.stringify(join(root, "continue"))}).exists())) await Bun.sleep(10);`,
        ],
        env: {},
        runOn: ["create"],
      },
    ];
  });
  try {
    await f.waitFor(() => existsSync(join(f.root, "setup")));
    expect(f.frames.some((frame) => frame.type === "runtime_ready")).toBe(false);
    await Bun.write(join(f.root, "continue"), "go");
    await f.waitFor(() => f.frames.some((frame) => frame.type === "setup_complete"));
    const completed = f.frames.find((frame) => frame.type === "setup_complete");
    if (completed?.type !== "setup_complete") throw new Error("Setup completion missing");
    expect(f.frames.some((frame) => frame.type === "runtime_ready")).toBe(false);
    f.send("process_start", { execution: f.execution, fingerprint: `sha256:${"a".repeat(64)}`, operation: "run" });
    f.send("setup_complete_ack", completed.payload);
    await f.waitFor(() => f.frames.some((frame) => frame.type === "runtime_ready"));
    expect(facts(f.frames)).toEqual([]);
  } finally {
    f.send("shutdown", { reason: "fixture-ended" });
    await f.child.exited;
    await f.close();
  }
});

test("canonical checkpoint capture stops service writers without an alpha harness", async () => {
  const mounts: PersistenceMount[] = [];
  const f = await fixture([process.execPath, "-e", "process.exit(0)"], async (exec, root) => {
    if (!exec.workload) throw new Error("Missing workload");
    exec.workload.profile = "service";
    const pidPath = join(root, "writer.pid");
    exec.workload.infrastructure = {
      writer: {
        command: [
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(()=>{},10);`,
        ],
        env: {},
      },
    };
    exec.checkpoint_hook = { command: [process.execPath, "-e", "process.exit(0)"], env: {}, timeout_seconds: 1 };
    mounts.push({ name: "state", target: root, maxBytes: 1048576, maxFiles: 100 });
    exec.persistence.mounts = mounts;
  });
  try {
    await f.waitFor(() => existsSync(join(f.root, "writer.pid")));
    const pid = Number(await Bun.file(join(f.root, "writer.pid")).text());
    f.send("prepare_checkpoint_archive", {
      operation_id: randomUUID(),
      checkpoint_id: randomUUID(),
      deadline_ms: 3000,
      mounts,
      max_archive_bytes: 1048576,
      max_index_bytes: 1048576,
      max_queue_bytes: 1048576,
    });
    await f.waitFor(() =>
      f.frames.some(
        (frame) =>
          frame.type === "checkpoint_prepared" ||
          (frame.type === "checkpoint_status" && frame.payload.phase === "failed"),
      ),
    );
    expect(
      f.frames.some((frame) => frame.type === "checkpoint_prepared"),
      JSON.stringify(f.frames.filter((frame) => frame.type.startsWith("checkpoint"))),
    ).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(f.child.exitCode).toBeNull();
  } finally {
    f.send("shutdown", { reason: "fixture-ended" });
    await f.child.exited;
    await f.close();
  }
});

test("canonical checkpoint deadline fails when an escaped writer holds its output pipe", async () => {
  let escapedPid: number | undefined;
  const f = await fixture([process.execPath, "-e", "process.exit(0)"], async (exec, root) => {
    if (!exec.workload) throw new Error("Missing workload");
    exec.workload.profile = "service";
    exec.checkpoint_hook = { command: [process.execPath, "-e", "process.exit(0)"], env: {}, timeout_seconds: 1 };
    const pidPath = join(root, "escaped.pid");
    const script = `const child = Bun.spawn([process.execPath, '-e', 'setInterval(()=>{},1000)'], {detached:true,stdin:'ignore',stdout:'inherit',stderr:'inherit'}); await Bun.write(${JSON.stringify(pidPath)}, String(child.pid)); setInterval(()=>{},1000);`;
    exec.workload.infrastructure = { writer: { command: [process.execPath, "-e", script], env: {} } };
  });
  try {
    await f.waitFor(() => existsSync(join(f.root, "escaped.pid")));
    escapedPid = Number(await Bun.file(join(f.root, "escaped.pid")).text());
    f.send("prepare_checkpoint_archive", {
      operation_id: randomUUID(),
      checkpoint_id: randomUUID(),
      deadline_ms: 100,
      mounts: [],
      max_archive_bytes: 1048576,
      max_index_bytes: 1048576,
      max_queue_bytes: 1048576,
    });
    await f.waitFor(() =>
      f.frames.some((frame) => frame.type === "checkpoint_status" && frame.payload.phase === "failed"),
    );
    expect(f.frames.some((frame) => frame.type === "checkpoint_prepared")).toBe(false);
    expect(f.child.exitCode).toBeNull();
  } finally {
    if (escapedPid) process.kill(-escapedPid, "SIGKILL");
    f.send("shutdown", { reason: "fixture-ended" });
    await f.child.exited;
    await f.close();
  }
});

test("canonical capture rejects a snapshot without its writer hook", async () => {
  const f = await fixture([process.execPath, "-e", "process.exit(0)"], async (exec) => {
    if (!exec.workload) throw new Error("Missing workload");
    exec.workload.profile = "service";
  });
  try {
    await f.waitFor(() => f.frames.some((frame) => frame.type === "runtime_ready"));
    f.send("prepare_checkpoint_archive", {
      operation_id: randomUUID(),
      checkpoint_id: randomUUID(),
      deadline_ms: 100,
      mounts: [],
      max_archive_bytes: 1048576,
      max_index_bytes: 1048576,
      max_queue_bytes: 1048576,
    });
    await f.waitFor(() =>
      f.frames.some((frame) => frame.type === "checkpoint_status" && frame.payload.phase === "failed"),
    );
    expect(f.frames.some((frame) => frame.type === "checkpoint_prepared")).toBe(false);
  } finally {
    f.send("shutdown", { reason: "fixture-ended" });
    await f.child.exited;
    await f.close();
  }
});
