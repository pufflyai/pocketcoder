import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseStore } from "@pstdio/pocketcoder-db";
import { createPostgresTestDatabase, TEST_DATABASE_URL } from "@pstdio/pocketcoder-db/testing";
import { loadConfig } from "@pstdio/pocketcoder-server/config";
import { startPocketCoderServer } from "@pstdio/pocketcoder-server/lifecycle";
import { migrateWithRelease, previousRelease, seedWithRelease } from "./previous-release";

const PEPPER = "upgrade-harness-pepper";
const root = resolve(import.meta.dir, "../..");

// PC-150: every release upgrades the previous release's database in place.
const cases = [
  { name: "0.8.0", seed: "v0.8.0", identities: false },
  { name: "0.8.1", seed: "v0.8.1", identities: true },
  // 0.7.1 wrote JSON objects as jsonb strings; 0.8.1 then migrated that database.
  { name: "0.7.1-origin", seed: "@pstdio/pocketcoder-cli@0.7.1", via: "v0.8.1", identities: false },
];

async function currentMigrate(databaseUrl: string) {
  const child = Bun.spawn(["bun", "--no-env-file", "packages/cli/src/index.ts", "db", "migrate"], {
    cwd: root,
    env: { ...Bun.env, POCKETCODER_DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`pcd db migrate failed: ${stderr || stdout}`);
  return stdout;
}

describe.skipIf(!TEST_DATABASE_URL)("in-place upgrade from the previous release", () => {
  test.each(cases)(
    "$name PostgreSQL database upgrades in place",
    async ({ seed, via, identities }) => {
      const database = await createPostgresTestDatabase("pc_upgrade", { migrate: false });
      const directory = await mkdtemp(join(tmpdir(), "pc-upgrade-controller-"));
      let running: Awaited<ReturnType<typeof startPocketCoderServer>> | undefined;
      try {
        const release = await previousRelease(seed);
        await migrateWithRelease(release, database.url);
        const seeded = await seedWithRelease(release, database.url, PEPPER);
        if (via) await migrateWithRelease(await previousRelease(via), database.url);

        const output = await currentMigrate(database.url);
        expect(output).toContain("applied:");
        expect(output).toContain("converted conversation history of 1 workspaces");
        expect(await currentMigrate(database.url)).toContain("database is up to date");
        const [template] = await database.admin.unsafe(
          `SELECT jsonb_typeof(spec) AS kind FROM pocketcoder.templates WHERE name = 'upgrade-fixture'`,
        );
        expect(template).toEqual({ kind: "object" });

        // Admission still works on carried-over state.
        const store = await DatabaseStore.openPostgres({ url: database.url });
        try {
          const admitted = await store.claimWorkspaceAdmission({
            workspaceId: seeded.queuedWorkspaceId,
            at: new Date(),
            registrationDigest: new Uint8Array([1]),
            registrationExpiresAt: new Date(Date.now() + 60_000),
            limits: { globalActiveWorkspaces: 10, perPrincipalActiveWorkspaces: 10, perTemplateActiveWorkspaces: {} },
          });
          expect(admitted?.state).toBe("provisioning");
        } finally {
          await store.close();
        }

        running = await startPocketCoderServer(
          {
            ...loadConfig({
              POCKETCODER_DATABASE_URL: database.url,
              POCKETCODER_AUTH_PEPPER: PEPPER,
              POCKETCODER_JOURNAL_DIR: database.journalDir,
              POCKETCODER_DIR: directory,
              POCKETCODER_STORAGE_BACKEND: "filesystem",
              POCKETCODER_WORKSPACE_DATA_DIR: join(directory, "workspaces"),
              POCKETCODER_CHECKPOINT_DIR: join(directory, "checkpoints"),
            }),
            listenPort: 0,
            agentPort: 0,
          },
          { log: () => {} },
        );
        const headers = { authorization: `Bearer ${seeded.token}` };
        // The key issued by the previous release still authenticates.
        expect((await fetch(`${running.url}/v1/principals`, { headers })).status).toBe(200);
        const history = await fetch(`${running.url}/v1/workspaces/${seeded.endedWorkspaceId}/conversation`, {
          headers,
        });
        expect(history.status).toBe(200);
        const body = (await history.json()) as { items: { content: string }[] };
        expect(body.items.map((item) => item.content)).toEqual([
          "first message from an earlier release",
          ...(identities ? ["Draft answer from 0.8.1"] : []),
          "second message from an earlier release",
        ]);
        if (seeded.conversationId) {
          const conversation = await fetch(
            `${running.url}/v1/workspaces/${seeded.endedWorkspaceId}/conversations/${seeded.conversationId}`,
            { headers },
          );
          expect(((await conversation.json()) as { items: { content: string }[] }).items).toEqual([
            expect.objectContaining({ content: "Draft answer from 0.8.1" }),
          ]);
        }
        // Old workspaces stay readable. Their checkpoints live on a storage backend this
        // controller does not use, so restore and resume end with an explicit result.
        const old = await fetch(`${running.url}/v1/workspaces/${seeded.endedWorkspaceId}`, { headers });
        expect(old.status).toBe(200);
        for (const path of [
          `/v1/checkpoints/${seeded.checkpointId}/restore`,
          `/v1/workspaces/${seeded.endedWorkspaceId}/resume`,
        ]) {
          const restore = await fetch(`${running.url}${path}`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
            body: JSON.stringify({ external_id: "restored-after-upgrade" }),
          });
          expect(restore.status).toBe(409);
          expect(await restore.json()).toMatchObject({
            error: { code: "checkpoint.unsupported", details: { provider_kind: "kubernetes-pvc" } },
          });
        }
      } finally {
        await running?.stop();
        await database.drop();
        await rm(directory, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
