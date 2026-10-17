import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WorkloadAcceptance } from "@pstdio/pocketcoder-contracts";
import { executionConversationIdentity, serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { processDispatchFixture } from "./process-dispatch-fixture.test";

test.each([1, 20])(
  "held service accept with concurrency %s cannot delay another process cancel",
  async (concurrency) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const producer = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/status") return Response.json({ status: "stable" });
        if (path === "/executions/ack") return new Response(null, { status: 200 });
        const body = (await request.json()) as { acceptance: WorkloadAcceptance };
        entered = true;
        await gate;
        return Response.json({
          execution: body.acceptance.execution,
          fingerprint: body.acceptance.fingerprint,
          phase: "running",
          outcome: null,
        });
      },
    });
    const f = await processDispatchFixture(
      (source) => {
        source.spec.limits.finalizationSeconds = 1;
        const adapter = source.spec.adapters.main;
        if (!adapter) throw new Error("Adapter missing");
        adapter.command = [process.execPath, "-e", "setInterval(()=>{},1000)"];
      },
      undefined,
      { concurrency },
    );
    const g = await processDispatchFixture((source) => {
      serviceExecutionTemplate(source, Number(producer.url.port));
      const service = source.spec.services.agent;
      if (!service) throw new Error("Service missing");
      for (const route of service.routes) route.deadlineSeconds = 3;
    }, f);
    const tasks: Promise<unknown>[] = [];
    try {
      const a = f.acceptance();
      await f.store.executions.accept(a, new Date());
      await f.dispatcher.tick();
      await f.waitFor(async () => (await f.store.executions.get(a.execution))?.phase === "running");
      const b = g.acceptance();
      await f.store.executions.accept(b, new Date(), executionConversationIdentity(b.execution.requestId));
      tasks.push(f.dispatcher.tick());
      await f.waitFor(async () => entered);
      await f.store.executions.cancel(
        { execution: a.execution, cancelId: randomUUID(), scope: "operation" },
        new Date(),
      );
      tasks.push(f.dispatcher.tick());
      await Bun.sleep(1250);
      expect((await f.store.executions.get(a.execution))?.phase).toBe("terminal");
    } finally {
      release();
      await Promise.allSettled(tasks);
      const pid = (await f.store.getWorkspace(f.id))?.finiteProcess?.processGroupId;
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
      await g.dispose();
      await f.dispose();
      await producer.stop(true);
    }
  },
);
