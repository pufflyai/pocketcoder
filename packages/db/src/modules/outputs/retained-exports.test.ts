import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, sha256Hex, type WorkloadExportReference } from "@pstdio/pocketcoder-contracts";
import { DatabaseStore } from "../../store";
import { executionFixture } from "../workspaces/execution-fixture.test";
import { executionConversationIdentity, serviceExecutionTemplate } from "../workspaces/execution-service-fixture.test";

test.each([
  ["memory", false],
  ["disk", false],
  ["memory", true],
] as const)(
  "%s exports freeze bytes and receipts across commit and restart (conversation: %s)",
  async (mode, conversation) => {
    const f = await executionFixture(conversation ? serviceExecutionTemplate : undefined, { mode });
    let store = f.store;
    async function restart() {
      if (mode !== "disk") return;
      if (!f.directory) throw new Error("Disk fixture directory missing");
      await store.close();
      store = await DatabaseStore.openPGlite(f.directory);
    }
    try {
      const accepted = f.acceptance();
      await f.store.executions.accept(
        accepted,
        new Date(),
        conversation ? executionConversationIdentity(accepted.execution.requestId) : undefined,
      );
      await f.store.executions.claim(accepted.execution, new Date());
      await f.store.executions.observe(accepted.execution, accepted.fingerprint, "terminal", 1, new Date(), {
        exitCode: 0,
      });
      await f.store.executions.acknowledge(accepted.execution, accepted.fingerprint, new Date());
      const bytes = Buffer.from("result");
      const objectId = randomUUID();
      const object = {
        objectId,
        objectVersion: `sha256:${sha256Hex(bytes)}`,
        digest: `sha256:${sha256Hex(bytes)}`,
        name: "result.txt",
        sizeBytes: bytes.length,
        mediaType: "text/plain",
      };
      const core = { execution: accepted.execution, objects: [object], completeness: "complete" as const, errors: [] };
      const manifest: WorkloadExportReference = {
        ...core,
        exportId: randomUUID(),
        manifestDigest: digestOf(core),
        publication: "published",
        publishedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
      let exports = store.exports;
      const capacity = {
        workspace: { bytes: 4194304, files: 16 },
        principal: { bytes: 8388608, files: 32 },
        instance: { bytes: 16777216, files: 64 },
        freeDisk: { bytes: 33554432, files: 128, headroomBytes: 0, headroomFiles: 0 },
      };
      await expect(exports.commit(manifest, [{ objectId, bytes: Buffer.from("wrong") }], new Date())).rejects.toThrow();
      expect((await store.executions.get(accepted.execution))?.collection).toBeUndefined();
      await restart();
      exports = store.exports;
      expect((await store.executions.get(accepted.execution))?.collection).toBeUndefined();
      await exports.commit(manifest, [{ objectId, bytes }], new Date(), capacity);
      await restart();
      exports = store.exports;
      expect((await store.executions.get(accepted.execution))?.collection).toEqual(manifest);
      await exports.commit(manifest, [{ objectId, bytes }], new Date());
      expect(await exports.content(f.id, objectId, randomUUID(), new Date())).toBeNull();
      expect(Buffer.from((await exports.content(f.id, objectId, f.principal.id, new Date()))!).toString()).toBe(
        "result",
      );
      await exports.completeCleanup(accepted.execution);
      expect((await store.executions.get(accepted.execution))?.collection?.cleanupState).toBe("complete");
      expect((await store.executions.get(accepted.execution))?.collection?.manifestDigest).toBe(
        manifest.manifestDigest,
      );
      await exports.commit(manifest, [{ objectId, bytes }], new Date());
      await exports.prune(new Date(Date.now() + 60001));
      expect(await exports.content(f.id, objectId, f.principal.id, new Date())).toBeNull();
      expect((await store.executions.get(accepted.execution))?.collection?.objects).toHaveLength(1);
      await exports.delete(accepted.execution, manifest.exportId, f.principal.id, new Date());
      expect((await store.executions.get(accepted.execution))?.collection?.publication).toBe("unavailable");
    } finally {
      if (store !== f.store) await store.close();
      await f.dispose();
    }
  },
);
