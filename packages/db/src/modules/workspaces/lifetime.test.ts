import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { executionFixture } from "./execution-fixture.test";
import { extendWorkspaceDeadline } from "./lifetime";

test("authorized lifetime extension is atomic, bounded and cannot revive expired work", async () => {
  const f = await executionFixture();
  try {
    const at = new Date();
    const row = (await f.store.getWorkspace(f.id))!;
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({
        deadlineAt: new Date(at.getTime() + 1000),
        lifetime: { ceilingAt: new Date(at.getTime() + 60000).toISOString(), revision: 1, extensions: {} },
        templateSnapshot: {
          ...row.templateSnapshot,
          name: f.runtime.template.name,
          version: f.runtime.template.version,
          manifest: f.runtime.template.manifest,
        },
      })
      .where(eq(f.context.tables.workspaces.id, f.id));
    const extend = extendWorkspaceDeadline(f.context);
    const next = new Date(at.getTime() + 2000);
    const command = { extensionId: randomUUID(), expectedRevision: 1, deadlineAt: next.toISOString() };
    await expect(extend(f.id, randomUUID(), command, () => at)).rejects.toThrow();
    await expect(
      extend(f.id, f.principal.id, { ...command, deadlineAt: new Date(at.getTime() + 60001).toISOString() }, () => at),
    ).rejects.toThrow();
    expect((await extend(f.id, f.principal.id, command, () => at)).deadlineAt).toBe(next.toISOString());
    expect(
      await f.store.transition(f.id, {
        from: ["ready"],
        to: "terminating",
        reason: "deadline_expired",
        at: new Date(at.getTime() + 1001),
        expectedDeadlineAt: new Date(at.getTime() + 1000),
      }),
    ).toBeNull();
    expect((await extend(f.id, f.principal.id, command, () => at)).deadlineAt).toBe(next.toISOString());
    await expect(
      extend(
        f.id,
        f.principal.id,
        {
          ...command,
          extensionId: randomUUID(),
          expectedRevision: 2,
          deadlineAt: new Date(at.getTime() + 3000).toISOString(),
        },
        () => new Date(at.getTime() + 2001),
      ),
    ).rejects.toThrow();
    await expect(
      extend(f.id, f.principal.id, { ...command, deadlineAt: new Date(at.getTime() + 2500).toISOString() }, () => at),
    ).rejects.toThrow();
    await expect(extend(f.id, f.principal.id, { ...command, extensionId: randomUUID() }, () => at)).rejects.toThrow();
    expect((await f.store.getWorkspace(f.id))?.principalId).toBe(f.principal.id);
  } finally {
    await f.dispose();
  }
});

test.each([false, true])("expiry and extension serialize across restart (expiry first: %s)", async (expiryFirst) => {
  const f = await executionFixture(undefined, { mode: "disk" });
  let store = f.store;
  try {
    const at = new Date();
    const old = new Date(at.getTime() + 1000);
    const ceilingAt = new Date(at.getTime() + 60000).toISOString();
    await f.context.db
      .update(f.context.tables.workspaces)
      .set({ deadlineAt: old, lifetime: { ceilingAt, revision: 1, extensions: {} } })
      .where(eq(f.context.tables.workspaces.id, f.id));
    const command = {
      extensionId: randomUUID(),
      expectedRevision: 1,
      deadlineAt: new Date(at.getTime() + 2000).toISOString(),
    };
    const extend = () => store.extendWorkspaceDeadline(f.id, f.principal.id, command, () => at);
    const expire = () =>
      store.transition(f.id, {
        from: ["ready"],
        to: "terminating",
        reason: "deadline_expired",
        at: old,
        expectedDeadlineAt: old,
      });
    const jobs = expiryFirst ? [expire, extend] : [extend, expire];
    await Promise.allSettled(jobs.map((job) => job()));
    if (!f.directory) throw new Error("Missing durable store");
    await store.close();
    const { DatabaseStore } = await import("../../store");
    store = await DatabaseStore.openPGlite(f.directory);
    const row = await store.getWorkspace(f.id);
    if (!row?.lifetime) throw new Error("Missing lifetime receipt");
    expect(row.lifetime.ceilingAt).toBe(ceilingAt);
    const extended = row.lifetime.extensions[command.extensionId];
    expect(Boolean(extended)).toBe(row.state === "ready");
    if (extended) {
      expect(row.deadlineAt.toISOString()).toBe(command.deadlineAt);
      expect(await store.extendWorkspaceDeadline(f.id, f.principal.id, command)).toEqual(extended);
    } else {
      expect(row.state).toBe("terminating");
      await expect(store.extendWorkspaceDeadline(f.id, f.principal.id, command)).rejects.toThrow();
    }
  } finally {
    if (store !== f.store) await store.close();
    await f.dispose();
  }
});
