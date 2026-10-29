import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresTestDatabase, TEST_DATABASE_URL } from "@pstdio/pocketcoder-db/testing";
import { fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import { loadConfig } from "../config/config";
import { startPocketCoderServer } from "./lifecycle";

type Running = Awaited<ReturnType<typeof startPocketCoderServer>>;

async function postgresController() {
  const database = await createPostgresTestDatabase("pc_server");
  const directory = await mkdtemp(join(tmpdir(), "pc-postgres-controller-"));
  const config = {
    ...loadConfig({
      POCKETCODER_DATABASE_URL: database.url,
      POCKETCODER_AUTH_PEPPER: "disposable-postgres-pepper",
      POCKETCODER_JOURNAL_DIR: database.journalDir,
      POCKETCODER_DIR: directory,
    }),
    listenPort: 0,
    agentPort: 0,
  };
  const owner = async () => {
    const response = await fetch("http://localhost/v1/owner", {
      unix: join(directory, "admin.sock"),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: crypto.randomUUID(),
        automation: true,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { token: string; key: { id: string; principal_id: string } };
  };
  return {
    database,
    config,
    owner,
    async dispose(running?: Running) {
      await running?.stop();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)("controller on PostgreSQL", () => {
  test("serves from PostgreSQL and keeps its data across restarts", async () => {
    const controller = await postgresController();
    let running: Running | undefined;
    try {
      const logs: string[] = [];
      running = await startPocketCoderServer(controller.config, { log: (line) => logs.push(line) });
      expect(logs).toContain(`store: postgres (schema pocketcoder)`);
      const { token } = await controller.owner();
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const template = fixtureTemplateEcho();
      const published = await fetch(`${running.url}/v1/templates`, {
        method: "POST",
        headers,
        body: JSON.stringify({ manifest: template.manifest }),
      });
      expect(published.status).toBe(201);
      await running.stop();
      running = await startPocketCoderServer(controller.config, { log: () => {} });
      const catalog = await fetch(`${running.url}/v1/templates`, { headers });
      expect(await catalog.json()).toMatchObject({ items: [{ digest: template.digest }] });
    } finally {
      await controller.dispose(running);
    }
  }, 60_000);

  test("a database restore cannot bring back a revoked key", async () => {
    const controller = await postgresController();
    let running: Running | undefined;
    try {
      running = await startPocketCoderServer(controller.config, { log: () => {} });
      const kept = await controller.owner();
      const revoked = await controller.owner();
      const revoke = await fetch(`${running.url}/v1/principals/${revoked.key.principal_id}/keys/${revoked.key.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${kept.token}` },
      });
      expect(revoke.status).toBe(200);
      await running.stop();
      running = undefined;
      // A point-in-time restore from before the revocation brings the key row back.
      await controller.database.admin.unsafe(
        `UPDATE "pocketcoder"."machine_keys" SET revoked_at = NULL WHERE id = '${revoked.key.id}'`,
      );
      running = await startPocketCoderServer(controller.config, { log: () => {} });
      const denied = await fetch(`${running.url}/v1/templates`, {
        headers: { authorization: `Bearer ${revoked.token}` },
      });
      expect(denied.status).toBe(401);
      const allowed = await fetch(`${running.url}/v1/templates`, {
        headers: { authorization: `Bearer ${kept.token}` },
      });
      expect(allowed.status).toBe(200);
    } finally {
      await controller.dispose(running);
    }
  }, 60_000);

  test("a second controller on the same database refuses to start", async () => {
    const controller = await postgresController();
    let running: Running | undefined;
    const otherDirectory = await mkdtemp(join(tmpdir(), "pc-postgres-second-"));
    const otherJournal = await mkdtemp(join(tmpdir(), "pc-postgres-second-journal-"));
    try {
      running = await startPocketCoderServer(controller.config, { log: () => {} });
      await expect(
        startPocketCoderServer(
          {
            ...controller.config,
            dataDir: otherDirectory,
            journalDir: controller.database.journalDir,
          },
          { log: () => {} },
        ),
      ).rejects.toThrow("Deletion journal is in use");
      await expect(
        startPocketCoderServer(
          { ...controller.config, dataDir: otherDirectory, journalDir: otherJournal },
          { log: () => {} },
        ),
      ).rejects.toThrow("Deletion journal is missing");
    } finally {
      await controller.dispose(running);
      await rm(otherDirectory, { recursive: true, force: true });
      await rm(otherJournal, { recursive: true, force: true });
    }
  }, 60_000);
});
