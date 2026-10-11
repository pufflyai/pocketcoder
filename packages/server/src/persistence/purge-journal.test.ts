import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotOf } from "@pstdio/pocketcoder-contracts";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { bootstrapLocalOwnerKey, DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { fixtureTemplatePersistent } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "../app";

test("a committed purge intent cannot start its worker before remote acknowledgement after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc93-purge-journal-"));
  const directory = join(root, "data");
  const inputDir = join(root, "inputs");
  await mkdir(inputDir);
  const endpoint = Bun.serve({ port: 0, fetch: () => new Response() });
  const unavailable = endpoint.url.toString();
  endpoint.stop(true);
  let store = await PGliteStore.create(directory);
  const pepper = "pc93-purge-pepper";
  try {
    const caller = await bootstrapLocalOwnerKey(store, pepper, {
      request_id: "caller",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const parsed = fixtureTemplatePersistent();
    const snapshot = snapshotOf(parsed);
    const template = await store.upsertTemplate({ ...snapshot, description: null });
    const id = randomUUID();
    const at = new Date();
    await store.insertWorkspace({
      id,
      principalId: caller.key.principal_id,
      externalId: id,
      idempotencyKey: id,
      requestDigest: id,
      templateId: template.row.id,
      templateSnapshot: snapshot,
      launchInput: null,
      metadata: {},
      deadlineAt: new Date(Date.now() + 60_000),
      createdAt: at,
    });
    await writeFile(join(inputDir, `${id}.json`), "owned input");
    await store.close();
    const options = {
      acknowledgeJournal: async () => {
        await fetch(unavailable);
      },
    };
    let original: string | undefined;
    for (let restart = 0; restart < 2; restart++) {
      store = await PGliteStore.create(directory, options);
      const built = buildServer({
        store,
        driver: new DockerDriver({ inputDir }),
        pepper,
        limits: DEFAULT_LIMITS,
        workspaceServerUrl: "http://127.0.0.1:0",
      });
      try {
        const response = await built.app.request(`/v1/workspaces/${id}/purge`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${caller.token}`,
            "content-type": "application/json",
            "idempotency-key": "purge",
          },
          body: "{}",
        });
        expect(response.status).toBe(503);
        const operation = await store.getOperationByIdempotency(caller.key.principal_id, "purge", "purge");
        expect(operation).not.toBeNull();
        original ??= operation?.id;
        expect(operation?.id).toBe(original);
        await built.persistence.retryPurges();
        expect(await store.getOperation(original as string)).toMatchObject({ state: "pending", completedAt: null });
        expect((await store.getWorkspace(id))?.state).toBe("queued");
        expect(await Bun.file(join(inputDir, `${id}.json`)).text()).toBe("owned input");
      } finally {
        await built.scheduler.drain();
        await built.persistence.drain();
        await store.close();
      }
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
