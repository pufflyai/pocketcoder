import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { DatabaseStore } from "@pstdio/pocketcoder-db";
import { fixtureTemplatePersistent } from "@pstdio/pocketcoder-testkit";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config/config";
import { startPocketCoderServer } from "./lifecycle";

const dockerAvailable =
  Bun.which("docker") !== null &&
  Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

test.skipIf(!dockerAvailable)(
  "server starts, migrates and restarts with historical templates without a native harness",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pc-server-startup-"));
    const messages: string[] = [];
    let running: Awaited<ReturnType<typeof startPocketCoderServer>> | undefined;
    try {
      const store = await DatabaseStore.openPGlite(dir);
      try {
        const parsed = fixtureTemplatePersistent();
        await store.upsertTemplate({
          name: parsed.manifest.metadata.name,
          version: parsed.manifest.spec.version,
          digest: parsed.digest,
          description: null,
          spec: parsed.manifest.spec,
        });
        const historical = parseTemplateManifest({ ...parsed.manifest, metadata: { name: "historical" } });
        const { row: legacy } = await store.upsertTemplate({
          name: "historical",
          version: parsed.manifest.spec.version,
          digest: historical.digest,
          description: null,
          spec: historical.manifest.spec,
        });
        const spec = { ...parsed.manifest.spec };
        Reflect.deleteProperty(spec, "harness");
        // Upgrade wiring: seed the old persisted shape without using today's
        // strict publication boundary, then exercise complete server startup.
        const { templates } = store.context.tables;
        await store.context.db.update(templates).set({ spec }).where(eq(templates.id, legacy.id));
      } finally {
        await store.close();
      }
      const config = {
        ...loadConfig({ POCKETCODER_DIR: dir, POCKETCODER_AUTH_PEPPER: "disposable-test-pepper" }),
        listenHost: "127.0.0.1",
        listenPort: 0,
        agentPort: 0,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        running = await startPocketCoderServer(config, { log: (message) => messages.push(message) });
        expect((await fetch(`${running.url}/readyz`)).status).toBe(200);
        await running.stop();
        running = undefined;
      }
      expect(messages.filter((message) => message.includes("failed"))).toEqual([]);
    } finally {
      await running?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
