import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { inputFixture } from "./input-fixture.test";
import { InputStorage } from "./input-storage";

for (const phase of ["writing", "published", "committed"])
  test(`real process crash while ${phase} reconciles private objects`, async () => {
    const f = await inputFixture();
    let reopened: PGliteStore | undefined;
    try {
      const reference = f.reference();
      await f.store.inputs.begin(
        {
          reference,
          principalId: f.principal.id,
          reservationId: randomUUID(),
          transferExpiresAt: new Date(Date.now() + 20_000),
          retentionMs: f.limits.retentionMs,
          retainedUntil: new Date(Date.now() + 600_000),
        },
        f.limits,
        f.options.capacity,
      );
      await f.store.close();
      const child = Bun.spawn(
        [process.execPath, `${import.meta.dir}/input-crash-worker.ts`, f.directory!, f.root, phase],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).not.toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
      reopened = await PGliteStore.create(f.directory);
      const service = new InputStorage(reopened.inputs, f.options);
      await service.reconcile(new Date(Date.now() + 30_000));
      const row = (await reopened.inputs.get(f.workspace.id, reference.fileId))!;
      if (phase === "committed") {
        expect(row.state).toBe("ready");
        const projection = await service.freeze(randomUUID(), f.workspace.id, "restart", [reference.fileId]);
        expect(projection.manifest.objects).toEqual([reference]);
      } else {
        expect(row.state).toBe("expired");
        expect(await f.driver.list()).toHaveLength(0);
        expect((await reopened.storageReservations.get(row.reservationId))?.state).toBe("released");
      }
    } finally {
      await reopened?.close();
      await f.dispose();
    }
  });

test("restart removes unowned filesystem objects", async () => {
  const f = await inputFixture();
  try {
    const writer = await f.driver.create({
      workspaceId: f.workspace.id,
      fileId: randomUUID(),
      versionId: randomUUID(),
    });
    await writer.write(Buffer.from("unowned"));
    await writer.publish();
    await f.service.reconcile();
    expect(await f.driver.list()).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});
