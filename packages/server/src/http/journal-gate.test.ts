import { expect, test } from "bun:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { bootstrapLocalOwnerKey } from "@pstdio/pocketcoder-runtime-core";
import { Hono } from "hono";
import { createStructuredLogger } from "../observability/observability";
import { journalGate } from "./journal-gate";
import { type AppEnv, errorHandler, machineAuth, requestId } from "./middleware";

test("a metadata read cannot expose a revocation appended after its first remote barrier", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc93-journal-response-"));
  const endpoint = Bun.serve({ port: 0, fetch: () => new Response() });
  const unavailable = endpoint.url.toString();
  endpoint.stop(true);
  let offline = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const observed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const store = await PGliteStore.create(join(root, "data"), {
    acknowledgeJournal: async (snapshot) => {
      if (offline) {
        await fetch(unavailable);
        return;
      }
      const remote = await open(join(root, "independent-head.json"), "w", 0o600);
      try {
        await remote.writeFile(JSON.stringify(snapshot));
        await remote.sync();
      } finally {
        await remote.close();
      }
    },
  });
  try {
    const pepper = "pc93-race-pepper";
    const expires_at = new Date(Date.now() + 60_000).toISOString();
    const caller = await bootstrapLocalOwnerKey(store, pepper, { request_id: "caller", expires_at });
    const target = await bootstrapLocalOwnerKey(store, pepper, { request_id: "target", expires_at });
    const app = new Hono<AppEnv>();
    app.onError(errorHandler(createStructuredLogger(() => {})));
    app.use("*", requestId, machineAuth(store, pepper), journalGate(store));
    app.get("/keys", async (context) => {
      entered();
      await held;
      return context.json(await store.listMachineKeys(target.key.principal_id, { limit: 10 }));
    });
    const request = app.request("/keys", { headers: { authorization: `Bearer ${caller.token}` } });
    await observed;
    offline = true;
    await expect(store.revokeMachineKey(target.key.id, new Date(), caller.key.id)).rejects.toMatchObject({
      code: "journal.pending",
    });
    expect((await store.getMachineKeyWithPrincipal(target.key.id))?.key.revokedAt).not.toBeNull();
    release();
    const response = await request;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "journal.pending" } });
  } finally {
    release?.();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
