import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionInputManifestId } from "@pstdio/pocketcoder-contracts";
import { processDispatchFixture } from "./process-dispatch-fixture.test";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return process.platform !== "linux" || !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

test("cancel settles only after a TERM-ignoring descendant stops and leaves infrastructure running", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc129-cancel-group-"));
  const ready = join(root, "ready");
  const childPid = join(root, "child");
  const servicePid = join(root, "service");
  const f = await processDispatchFixture((source) => {
    source.spec.limits.finalizationSeconds = 1;
    const adapter = source.spec.adapters.main;
    if (!adapter) throw new Error("Adapter missing");
    adapter.command = [
      "/bin/sh",
      "-c",
      `(trap '' TERM; printf ready > '${ready}'; while :; do sleep 1; done) >/dev/null 2>&1 & echo $! > '${childPid}'; wait`,
    ];
    source.spec.services.survivor = {
      baseUrl: "http://127.0.0.1:9",
      required: false,
      healthPath: "/status",
      routes: [
        {
          method: "GET",
          path: "/status",
          query: [],
          responseMode: "buffered",
          maxRequestBytes: 65536,
          maxResponseBytes: 65536,
          deadlineSeconds: 1,
        },
      ],
      process: {
        command: [
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(servicePid)}, String(process.pid));setInterval(()=>{},1000);`,
        ],
        env: {},
      },
    };
  });
  let group: number | null | undefined;
  let service: number | undefined;
  try {
    const acceptance = f.acceptance();
    await f.store.executions.accept(acceptance, new Date());
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    await f.waitFor(async () => (await Bun.file(ready).exists()) && (await Bun.file(servicePid).exists()));
    group = (await f.store.getWorkspace(f.id))?.finiteProcess?.processGroupId;
    if (!group) throw new Error("Process group missing");
    service = Number(await Bun.file(servicePid).text());
    const child = Number(await Bun.file(childPid).text());
    expect(
      Number(
        Bun.spawnSync(["ps", "-p", String(child), "-o", "pgid="])
          .stdout.toString()
          .trim(),
      ),
    ).toEqual(group);
    f.dropAck = true;
    await f.store.executions.cancel(
      { execution: acceptance.execution, cancelId: randomUUID(), scope: "operation" },
      new Date(),
    );
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    await f.waitFor(async () => (await f.store.executions.get(acceptance.execution))?.phase === "terminal");
    expect(alive(child)).toBe(false);
    expect(alive(service)).toBe(true);
    const exact = (await f.store.getWorkspace(f.id))?.finiteProcess;
    f.dropAck = false;
    f.disconnect();
    await f.waitFor(async () => (f.hub.get(f.id)?.epoch ?? 0) > 1);
    expect((await f.store.getWorkspace(f.id))?.finiteProcess).toEqual(exact);
    expect(f.spawned).toBe(1);
  } finally {
    for (const pid of [group, service])
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary leader exit cannot release pins while a descendant still writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc129-exit-group-"));
  const ready = join(root, "ready");
  const childPid = join(root, "child");
  const f = await processDispatchFixture((source) => {
    source.spec.limits.finalizationSeconds = 1;
    const adapter = source.spec.adapters.main;
    if (!adapter) throw new Error("Adapter missing");
    adapter.command = [
      "/bin/sh",
      "-c",
      `(trap '' TERM; echo ready > '${ready}'; while :; do sleep 1; done) >/dev/null 2>&1 & echo $! > '${childPid}'; while [ ! -f '${ready}' ]; do sleep 0.01; done; exit 7`,
    ];
  });
  let group: number | null | undefined;
  try {
    const a = f.acceptance();
    await f.store.executions.accept(a, new Date());
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    await f.waitFor(async () => await Bun.file(ready).exists());
    group = (await f.store.getWorkspace(f.id))?.finiteProcess?.processGroupId;
    expect((await f.store.inputs.getManifest(executionInputManifestId(a)))?.finalizedAt).toBeNull();
    await expect(f.store.executions.finalize(a.execution, new Date())).rejects.toThrow("Unsettled");
    await f.waitFor(async () => (await f.store.executions.get(a.execution))?.phase === "terminal");
    expect(alive(Number(await Bun.file(childPid).text()))).toBe(false);
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    await f.store.executions.finalize(a.execution, new Date());
    expect((await f.store.inputs.getManifest(executionInputManifestId(a)))?.finalizedAt).toBeInstanceOf(Date);
    expect((await f.store.getWorkspace(f.id))?.finiteProcess).toMatchObject({ exitCode: 7, signal: null });
  } finally {
    if (group) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
    }
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
