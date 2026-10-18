import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processDispatchFixture } from "./process-dispatch-fixture.test";

test.each([
  ["dispatch", 750],
  ["dispatch", 1100],
  ["frame", 750],
  ["frame", 1100],
] as const)("%s delayed by %s ms keeps the accepted cancel deadline and services", async (delivery, delayMs) => {
  const root = await mkdtemp(join(tmpdir(), "pc-cancel-delivery-"));
  const ready = join(root, "ready"),
    exit = join(root, "exit"),
    exited = join(root, "exited"),
    ticks = join(root, "ticks"),
    servicePid = join(root, "service");
  const f = await processDispatchFixture((source) => {
    source.spec.limits.finalizationSeconds = 1;
    const adapter = source.spec.adapters.main;
    if (!adapter) throw new Error("Adapter missing");
    adapter.command = [
      "/bin/sh",
      "-c",
      `(trap '' TERM; echo ready > '${ready}'; while :; do printf x >> '${ticks}'; sleep 0.02; done) >/dev/null 2>&1 & while [ ! -f '${exit}' ]; do sleep 0.01; done; echo exited > '${exited}'; exit 7`,
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
          `await Bun.write(${JSON.stringify(servicePid)},String(process.pid));setInterval(()=>{},1000);`,
        ],
        env: {},
      },
    };
  });
  const send = f.hub.send.bind(f.hub);
  let dropCancel = true,
    group: number | null | undefined,
    service: number | undefined;
  let deliverHeld: (() => void) | undefined;
  f.hub.send = (connection, type, payload) => {
    if (type === "process_cancel" && dropCancel) {
      deliverHeld ??= () => send(connection, type, payload);
      return;
    }
    return send(connection, type, payload);
  };
  try {
    const a = f.acceptance();
    await f.store.executions.accept(a, new Date());
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    await f.waitFor(async () => (await Bun.file(ready).exists()) && (await Bun.file(servicePid).exists()));
    group = (await f.store.getWorkspace(f.id))?.finiteProcess?.processGroupId;
    const serviceId = Number(await Bun.file(servicePid).text());
    service = serviceId;
    const canceledAt = performance.now();
    await f.store.executions.cancel({ execution: a.execution, cancelId: randomUUID(), scope: "operation" }, new Date());
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    await Bun.sleep(delayMs);
    await Bun.write(exit, "exit");
    await f.waitFor(async () => await Bun.file(exited).exists());
    await Bun.sleep(20);
    dropCancel = false;
    if (delivery === "frame") {
      if (!deliverHeld) throw new Error("Cancel frame missing");
      deliverHeld();
    } else await f.dispatcher.tick();
    await f.dispatcher.drain();
    await f.waitFor(async () => (await f.store.executions.get(a.execution))?.phase === "terminal");
    expect(performance.now() - canceledAt).toBeLessThan(1400);
    expect((await f.store.getWorkspace(f.id))?.finiteProcess).toMatchObject({ exitCode: 7, signal: null });
    expect(() => process.kill(serviceId, 0)).not.toThrow();
    const stopped = await Bun.file(ticks).text();
    await Bun.sleep(60);
    expect(await Bun.file(ticks).text()).toBe(stopped);
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
