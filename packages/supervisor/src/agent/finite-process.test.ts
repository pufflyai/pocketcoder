import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FiniteProcess } from "./finite-process";

const reference = () => ({
  workspaceId: randomUUID(),
  incarnationId: "container-1",
  owner: "process" as const,
  requestId: randomUUID(),
});
const fingerprint = `sha256:${"a".repeat(64)}`;

test.each([0, 7])("waits for explicit start and retains exact exit %s", async (code) => {
  const root = await mkdtemp(join(tmpdir(), "pc-process-"));
  const marker = join(root, "started");
  const ref = reference();
  const facts: unknown[] = [];
  const processOwner = new FiniteProcess(ref.workspaceId, ref.incarnationId, (fact) => facts.push(fact));
  try {
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(processOwner.lookup(ref)).toBeNull();
    const command = {
      command: [process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, 'once'); process.exit(${code})`],
      env: {},
    };
    processOwner.start(ref, fingerprint, command);
    await processOwner.drained;
    expect(processOwner.lookup(ref)).toMatchObject({ phase: "exited", exitCode: code, signal: null });
    expect(processOwner.lookup(ref)?.startedAt).toBeString();
    expect(processOwner.lookup(ref)?.endedAt).toBeString();
    expect(processOwner.lookup(ref)?.processGroupId).toBeGreaterThan(0);
    processOwner.start(ref, fingerprint, command);
    expect(facts).toHaveLength(3);
    expect(() => processOwner.start({ ...ref, requestId: randomUUID() }, fingerprint, command)).toThrow(
      "already claimed",
    );
    expect(() => processOwner.start(ref, `sha256:${"b".repeat(64)}`, command)).toThrow("fingerprint");
    expect(() => processOwner.lookup({ ...ref, workspaceId: randomUUID() })).toThrow("runtime");
    expect(() => processOwner.lookup({ ...ref, incarnationId: "restored" })).toThrow("runtime");
  } finally {
    await processOwner.stopWriters("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("targets a long command's process group and records the observed signal", async () => {
  const ref = reference();
  const owner = new FiniteProcess(ref.workspaceId, ref.incarnationId, () => {});
  try {
    owner.start(ref, fingerprint, { command: [process.execPath, "-e", "setInterval(()=>{},1000)"], env: {} });
    expect(owner.lookup(ref)?.phase).toBe("running");
    expect(() => owner.cancel({ ...ref, requestId: randomUUID() }, "SIGTERM")).toThrow("request");
    owner.cancel(ref, "SIGTERM");
    await owner.drained;
    expect(owner.lookup(ref)).toMatchObject({ phase: "exited", exitCode: null, signal: "SIGTERM" });
  } finally {
    await owner.stopWriters("SIGKILL");
  }
});

test("ordinary exit stops descendant writers before finalization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-writers-"));
  const marker = join(root, "stopped");
  const ready = join(root, "writer-ready");
  const ref = reference();
  const owner = new FiniteProcess(ref.workspaceId, ref.incarnationId, () => {});
  const descendant = `const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(marker)},'stopped');process.exit(0)});writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},100);`;
  try {
    owner.start(ref, fingerprint, {
      command: [
        process.execPath,
        "-e",
        `Bun.spawn([${JSON.stringify(process.execPath)},'-e',${JSON.stringify(descendant)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}).unref();while(!Bun.file(${JSON.stringify(ready)}).size){await Bun.sleep(10)}`,
      ],
      env: {},
    });
    await owner.exited();
    const deadline = Date.now() + 1000;
    while (!(await Bun.file(ready).exists())) {
      if (Date.now() > deadline) throw new Error("Descendant writer did not start");
      await Bun.sleep(10);
    }
    expect(owner.lookup(ref)?.phase).toBe("exited");
    await owner.drained;
    while (!(await Bun.file(marker).exists())) {
      if (Date.now() > deadline) throw new Error("Descendant did not receive the group signal");
      await Bun.sleep(10);
    }
    expect(await Bun.file(marker).text()).toBe("stopped");
  } finally {
    await owner.stopWriters("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal notification waits for ordinary exit's descendant writers to stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-exit-writers-"));
  const ready = join(root, "ready");
  const pidPath = join(root, "child");
  const ref = reference();
  let terminalWhileWriting = false;
  let terminal = false;
  const owner = new FiniteProcess(
    ref.workspaceId,
    ref.incarnationId,
    (fact) => {
      if (fact.phase !== "exited") return;
      terminal = true;
      const pid = Number(readFileSync(pidPath, "utf8"));
      try {
        process.kill(pid, 0);
        terminalWhileWriting =
          process.platform !== "linux" || !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
      } catch {}
    },
    undefined,
    100,
  );
  try {
    owner.start(ref, fingerprint, {
      command: [
        "/bin/sh",
        "-c",
        `(trap '' TERM; echo ready > '${ready}'; while :; do sleep 1; done) >/dev/null 2>&1 & echo $! > '${pidPath}'; while [ ! -f '${ready}' ]; do sleep 0.01; done; exit 7`,
      ],
      env: {},
    });
    await owner.drained;
    expect(terminal).toBe(true);
    expect(terminalWhileWriting).toBe(false);
    expect(owner.lookup(ref)).toMatchObject({ phase: "exited", exitCode: 7, signal: null });
  } finally {
    await owner.stopWriters("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
