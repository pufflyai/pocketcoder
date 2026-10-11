import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { bootstrapLocalOwnerKey, DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";

test("an offline journal leaves revocation enforced and unacknowledged across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc93-journal-"));
  const directory = join(root, "data");
  const endpoint = Bun.serve({ port: 0, fetch: () => new Response() });
  const unavailable = endpoint.url.toString();
  endpoint.stop(true);
  let store = await PGliteStore.create(directory);
  const pepper = "pc93-test-pepper";
  const expires_at = new Date(Date.now() + 60_000).toISOString();
  try {
    const caller = await bootstrapLocalOwnerKey(store, pepper, { request_id: "caller", expires_at });
    const target = await bootstrapLocalOwnerKey(store, pepper, { request_id: "target", expires_at });
    await store.close();
    const options = {
      acknowledgeJournal: async () => {
        await fetch(unavailable);
      },
    };
    const path = `/v1/principals/${target.key.principal_id}/keys/${target.key.id}`;
    for (let restart = 0; restart < 2; restart++) {
      store = await PGliteStore.create(directory, options);
      const built = buildServer({
        store,
        driver: new DockerDriver({ inputDir: join(root, "inputs") }),
        pepper,
        limits: DEFAULT_LIMITS,
        workspaceServerUrl: "http://127.0.0.1:0",
      });
      const request = (route: string, token: string | null, method = "GET") =>
        built.app.request(route, { method, headers: { authorization: `Bearer ${token}` } });
      try {
        const response = await request(path, caller.token, "DELETE");
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: "journal.pending" } });
        expect((await store.getMachineKeyWithPrincipal(target.key.id))?.key.revokedAt).not.toBeNull();
        expect((await request(`/v1/principals/${target.key.principal_id}/keys`, target.token)).status).toBe(401);
        expect((await request(`/v1/principals/${target.key.principal_id}/keys`, caller.token)).status).toBe(503);
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
