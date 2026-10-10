import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";
import { PurgeOwnershipError, purgeTransferredStorage } from "./purge-storage";

test("unknown controller archives block purge without deleting unrelated bytes", async () => {
  const f = await checkpointHttpFixture();
  try {
    const preserve = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
    const grant = await f.grant;
    expect((await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body: f.raw })).status).toBe(201);
    const checkpoint = await preserve;
    const allocation = await f.store.getWorkspaceStorage(f.workspace.id);
    if (!allocation) throw new Error("Allocation missing");
    await writeFile(join(f.directory, "unrecorded.tar"), "unknown private archive");
    await expect(
      purgeTransferredStorage(
        { deps: { store: f.store, checkpointTransfers: f.service }, now: () => new Date() },
        f.workspace,
        [allocation],
        [checkpoint],
      ),
    ).rejects.toBeInstanceOf(PurgeOwnershipError);
    expect((await f.store.getCheckpoint(checkpoint.id))?.state).toBe("ready");
    expect((await f.store.getWorkspaceStorage(f.workspace.id))?.state).toBe("ready");
    expect(await readFile(join(f.directory, "unrecorded.tar"), "utf8")).toBe("unknown private archive");
  } finally {
    await f.dispose();
  }
});
