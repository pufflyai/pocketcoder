import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@pstdio/pocketcoder-contracts";
import { SessionProducer, sessionResponse } from "@pstdio/pocketcoder-supervisor/testing";
import { eq } from "drizzle-orm";
import { managedFixture } from "./managed-fixture.test";
import { sdkClient } from "./sdk-fixture.test";

test.each([
  { name: "Unicode report", bytes: Buffer.from("company,total\nÅngström,42\n") },
  { name: "maximum native payload", bytes: Buffer.alloc(2 * 1024 * 1024, 42) },
])(
  "native generated files download after close and physical content purge ($name)",
  async ({ bytes }) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-generated-files-")));
    const path = join(directory, "report.csv");
    await writeFile(path, bytes);
    let runs = 0;
    const producer = new SessionProducer(join(directory, "journal"), async (run) => {
      runs++;
      if (!run.publishFile) throw new Error("Missing publication capability");
      run.publishFile({ path, name: "Årsrapport.csv", mediaType: "text/csv" });
      run.emit("answer", "assistant", [{ type: "text", text: "Your report is ready." }], { type: "final_response" });
    });
    const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => sessionResponse(producer, request) });
    const m = await managedFixture(local.port, { outputRoots: [directory] });
    const { client, server, keyId } = await sdkClient(m);
    try {
      const sessionId = await m.session();
      const otherSession = await m.session();
      const body = { requestId: randomUUID(), message: "Make a report", attachments: [] };
      await client.requests.submit(sessionId, body);
      await m.settle();
      const collection = await client.requests.collection(sessionId, body.requestId);
      expect(collection).toMatchObject({
        state: "settled",
        completeness: "complete",
        objects: [
          {
            name: "Årsrapport.csv",
            sizeBytes: bytes.length,
            sha256: `sha256:${sha256Hex(bytes)}`,
            availability: "published",
          },
        ],
      });
      const output = collection.objects[0];
      if (!output) throw new Error("Missing retained output");
      expect(await client.files.content(sessionId, output.exportId)).toEqual(new Uint8Array(bytes));
      expect((await client.files.exports(sessionId, body.requestId)).items).toEqual(collection.objects);
      await client.requests.submit(sessionId, body);
      await m.settle();
      expect(runs).toBe(1);
      expect((await client.files.exports(sessionId, body.requestId)).items).toHaveLength(1);
      await expect(client.files.content(otherSession, output.exportId)).rejects.toMatchObject({ status: 404 });
      const anonymous = await server.app.request(`/v1/sessions/${sessionId}/exports/${output.exportId}/content`);
      expect(anonymous.status).toBe(401);
      await client.sessions.close(sessionId);
      await m.f.store.transition(m.f.id, { from: ["ready"], to: "terminating", at: new Date() });
      await m.f.store.transition(m.f.id, { from: ["terminating"], to: "canceled", at: new Date() });
      await m.f.context.db
        .update(m.f.context.tables.workspaces)
        .set({ purgeRequestedAt: new Date() })
        .where(eq(m.f.context.tables.workspaces.id, m.f.id));
      await m.f.store.purgeWorkspaceContent(m.f.id, new Date());
      await producer.shutdown();
      await local.stop(true);
      await writeFile(path, "overwritten after completion");
      expect(await client.files.content(sessionId, output.exportId)).toEqual(new Uint8Array(bytes));
      await m.f.store.exports.prune(new Date(Date.parse(output.expiresAt) + 1));
      await expect(client.files.content(sessionId, output.exportId)).rejects.toMatchObject({ status: 404 });
      await m.f.store.revokeMachineKey(keyId, new Date());
      await expect(client.files.content(sessionId, output.exportId)).rejects.toMatchObject({ status: 401 });
    } finally {
      await producer.shutdown();
      await local.stop(true);
      await m.f.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
