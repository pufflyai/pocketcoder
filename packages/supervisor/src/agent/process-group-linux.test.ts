import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FiniteProcess } from "./finite-process";

test.skipIf(process.platform !== "linux")("cancellation kills live worker threads after main-thread exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-thread-writers-"));
  const ready = join(root, "ready");
  const ticks = join(root, "ticks");
  const worker = join(root, "worker.js");
  await Bun.write(
    worker,
    `import {writeFileSync} from 'node:fs';let n=0;writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>writeFileSync(${JSON.stringify(ticks)},String(++n)),20);`,
  );
  const ref = {
    workspaceId: randomUUID(),
    incarnationId: "thread-runtime",
    owner: "process" as const,
    requestId: randomUUID(),
  };
  const facts: string[] = [];
  const owner = new FiniteProcess(ref.workspaceId, ref.incarnationId, (fact) => facts.push(fact.phase));
  let group: number | null | undefined;
  try {
    owner.start(ref, `sha256:${"a".repeat(64)}`, {
      command: [
        process.execPath,
        "-e",
        `import {dlopen} from 'bun:ffi';const c=dlopen('libc.so.6',{signal:{args:['i32','i64'],returns:'i64'},pthread_exit:{args:['ptr'],returns:'void'}});c.symbols.signal(15,1);new Worker(${JSON.stringify(worker)});while(!await Bun.file(${JSON.stringify(ready)}).exists())await Bun.sleep(10);c.symbols.pthread_exit(null);`,
      ],
      env: {},
    });
    group = owner.lookup(ref)?.processGroupId;
    if (!group) throw new Error("Process group missing");
    const deadline = Date.now() + 2000;
    while (!/\) Z /.test(readFileSync(`/proc/${group}/stat`, "utf8")) || !(await Bun.file(ticks).exists())) {
      if (Date.now() > deadline) throw new Error("Main thread did not exit while worker remained");
      await Bun.sleep(10);
    }
    const before = await Bun.file(ticks).text();
    await Bun.sleep(60);
    expect(await Bun.file(ticks).text()).not.toBe(before);
    owner.cancelOperation(ref, randomUUID(), "SIGTERM", 100);
    await Promise.race([
      owner.drained,
      Bun.sleep(1000).then(() => {
        throw new Error("Worker survived the cancellation budget");
      }),
    ]);
    expect(facts.at(-1)).toBe("exited");
    const stopped = await Bun.file(ticks).text();
    await Bun.sleep(60);
    expect(await Bun.file(ticks).text()).toBe(stopped);
  } finally {
    if (group) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
    }
    await owner.drained;
    await rm(root, { recursive: true, force: true });
  }
});
