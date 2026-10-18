import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { executionInputManifestId } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import { executionFixture } from "./execution-fixture.test";

test.each(["input", "principal", "deadline"])(
  "%s loss blocks replay but preserves claimed control",
  async (failure) => {
    const f = await executionFixture();
    try {
      const a = f.acceptance();
      await f.store.executions.accept(a, new Date());
      expect(await f.store.executions.reconcile(a.execution)).toBeNull();
      await f.store.executions.claim(a.execution, new Date());
      await f.store.executions.observe(a.execution, a.fingerprint, "running", 1, new Date());
      const running = await f.store.executions.get(a.execution);
      if (!running) throw new Error("Claimed execution missing");
      if (failure === "input")
        await f.context.db
          .delete(f.context.tables.inputManifests)
          .where(eq(f.context.tables.inputManifests.id, executionInputManifestId(a)));
      if (failure === "principal")
        await f.context.db
          .update(f.context.tables.principals)
          .set({ disabledAt: new Date() })
          .where(eq(f.context.tables.principals.id, f.principal.id));
      if (failure === "deadline")
        await f.context.db
          .update(f.context.tables.workspaces)
          .set({ deadlineAt: new Date(0) })
          .where(eq(f.context.tables.workspaces.id, f.id));
      expect((await f.store.executions.reconcile(a.execution))?.record).toEqual(running);
      expect(await f.store.executions.get(a.execution)).toEqual(running);
      const canceled = await f.store.executions.cancel(
        { execution: a.execution, cancelId: randomUUID(), scope: "operation" },
        new Date(),
      );
      expect((await f.store.executions.claim(a.execution, new Date()))?.record).toEqual(canceled);
      expect((await f.store.executions.reconcile(a.execution))?.record).toEqual(canceled);
    } finally {
      await f.dispose();
    }
  },
);

test.each(["input", "principal", "deadline"])(
  "producer-proven absence cannot bypass a failed %s launch check",
  async (failure) => {
    const f = await executionFixture();
    try {
      const a = f.acceptance();
      await f.store.executions.accept(a, new Date());
      await f.store.executions.claim(a.execution, new Date());
      if (failure === "input")
        await f.context.db
          .delete(f.context.tables.inputManifests)
          .where(eq(f.context.tables.inputManifests.id, executionInputManifestId(a)));
      if (failure === "principal")
        await f.context.db
          .update(f.context.tables.principals)
          .set({ disabledAt: new Date() })
          .where(eq(f.context.tables.principals.id, f.principal.id));
      if (failure === "deadline")
        await f.context.db
          .update(f.context.tables.workspaces)
          .set({ deadlineAt: new Date(0) })
          .where(eq(f.context.tables.workspaces.id, f.id));
      expect(await f.store.executions.claim(a.execution, new Date())).toBeNull();
      expect((await f.store.executions.get(a.execution))?.phase).toBe("lost");
      expect(await f.store.executions.reconcile(a.execution)).toBeNull();
    } finally {
      await f.dispose();
    }
  },
);

test.each(["purge", "principal", "incarnation", "ended"])("reconciliation retains the %s fence", async (fence) => {
  const f = await executionFixture();
  try {
    const a = f.acceptance();
    await f.store.executions.accept(a, new Date());
    await f.store.executions.claim(a.execution, new Date());
    const workspace = await f.store.getWorkspace(f.id);
    const runtime = workspace?.runtimeRegistration;
    if (!runtime) throw new Error("Runtime missing");
    const table = f.context.tables.workspaces;
    const patch = {
      ...(fence === "purge" ? { purgeRequestedAt: new Date() } : {}),
      ...(fence === "principal" ? { principalId: (await f.store.createPrincipal("other", ["admin"], ["*"])).id } : {}),
      ...(fence === "incarnation" ? { runtimeRegistration: { ...runtime, incarnationId: "replacement" } } : {}),
      ...(fence === "ended" ? { runtimeRegistration: { ...runtime, endedAt: new Date().toISOString() } } : {}),
    };
    await f.context.db.update(table).set(patch).where(eq(table.id, f.id));
    expect(await f.store.executions.reconcile(a.execution)).toBeNull();
  } finally {
    await f.dispose();
  }
});
