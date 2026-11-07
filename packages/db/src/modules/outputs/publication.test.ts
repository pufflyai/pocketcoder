import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "@pstdio/pocketcoder-contracts";
import { executionFixture } from "../workspaces/execution-fixture.test";
import { executionConversationIdentity, serviceExecutionTemplate } from "../workspaces/execution-service-fixture.test";

test("adapter publication freezes bytes before terminal, seals once and rejects changed IDs", async () => {
  const f = await executionFixture(
    (source) => {
      serviceExecutionTemplate(source);
      source.spec.operations.run!.outputRoots = ["/outputs"];
      source.spec.limits.exportRetentionSeconds = 1;
    },
    {
      capabilities: [
        "explicit-start",
        "exact-exit",
        "targeted-cancel",
        "request-lookup",
        "deduplicated-accept",
        "stop-before-export",
        "unknown-outcome",
        "explicit-publication",
      ],
    },
  );
  try {
    const acceptance = f.acceptance();
    await f.store.executions.accept(
      acceptance,
      new Date(),
      executionConversationIdentity(acceptance.execution.requestId),
    );
    await f.store.executions.claim(acceptance.execution, new Date());
    const bytes = Buffer.from("original");
    const publication = {
      publicationId: randomUUID(),
      name: "report.txt",
      mediaType: "text/plain",
      bytes,
      sizeBytes: bytes.length,
      digest: `sha256:${sha256Hex(bytes)}`,
    };
    const capacity = {
      workspace: { bytes: 4194304, files: 16 },
      principal: { bytes: 8388608, files: 32 },
      instance: { bytes: 16777216, files: 64 },
      freeDisk: { bytes: 33554432, files: 128, headroomBytes: 0, headroomFiles: 0 },
    };
    await f.store.exports.publish(
      acceptance.execution,
      acceptance.fingerprint,
      [publication],
      true,
      new Date(),
      capacity,
    );
    await expect(
      f.store.exports.publish(
        acceptance.execution,
        acceptance.fingerprint,
        [{ ...publication, bytes: Buffer.from("modified") }],
        true,
        new Date(),
        capacity,
      ),
    ).rejects.toThrow();
    const changed = Buffer.from("changed");
    await expect(
      f.store.exports.publish(
        acceptance.execution,
        acceptance.fingerprint,
        [{ ...publication, bytes: changed, sizeBytes: changed.length, digest: `sha256:${sha256Hex(changed)}` }],
        true,
        new Date(),
        capacity,
      ),
    ).rejects.toThrow("identity");
    expect((await f.store.executions.get(acceptance.execution))?.collection).toBeUndefined();
    await f.store.exports.prune(new Date(Date.now() + 1001));
    await f.store.executions.observe(acceptance.execution, acceptance.fingerprint, "terminal", 1, new Date(), {
      status: "completed",
    });
    const manifest = await f.store.exports.seal(acceptance.execution, new Date());
    bytes.fill(0);
    expect(manifest.completeness).toBe("complete");
    expect(await f.store.exports.seal(acceptance.execution, new Date())).toEqual(manifest);
    const object = manifest.objects[0]!;
    expect(
      Buffer.from((await f.store.exports.content(f.id, object.objectId, f.principal.id, new Date()))!).toString(),
    ).toBe("original");
    expect((await f.store.executions.get(acceptance.execution))?.finalizedAt).toBeNull();
    const replay = { ...publication, bytes: Buffer.from("original") };
    await f.store.exports.prune(new Date(Date.now() + 1001));
    expect(await f.store.exports.content(f.id, object.objectId, f.principal.id, new Date())).toBeNull();
    await f.store.exports.publish(acceptance.execution, acceptance.fingerprint, [replay], true, new Date(), capacity);
    expect(await f.store.exports.content(f.id, object.objectId, f.principal.id, new Date())).toBeNull();
    await expect(
      f.store.exports.publish(
        acceptance.execution,
        acceptance.fingerprint,
        [{ ...replay, name: "changed.txt" }],
        true,
        new Date(),
        capacity,
      ),
    ).rejects.toThrow("identity");
    await f.store.executions.acknowledge(acceptance.execution, acceptance.fingerprint, new Date());
    await f.store.executions.finalize(acceptance.execution, new Date());
    expect((await f.store.executions.get(acceptance.execution))?.finalizedAt).not.toBeNull();
  } finally {
    await f.dispose();
  }
});

test.each([true, false])(
  "explicit empty publication and cancellation before publication stay distinct (complete: %s)",
  async (complete) => {
    const f = await executionFixture(
      (source) => {
        serviceExecutionTemplate(source);
        const run = source.spec.operations.run;
        if (!run) throw Error("Missing operation");
        run.outputRoots = ["/outputs"];
      },
      {
        capabilities: [
          "explicit-start",
          "exact-exit",
          "targeted-cancel",
          "request-lookup",
          "deduplicated-accept",
          "stop-before-export",
          "unknown-outcome",
          "explicit-publication",
        ],
      },
    );
    try {
      const acceptance = f.acceptance();
      await f.store.executions.accept(
        acceptance,
        new Date(),
        executionConversationIdentity(acceptance.execution.requestId),
      );
      await f.store.executions.claim(acceptance.execution, new Date());
      if (complete) await f.store.exports.publish(acceptance.execution, acceptance.fingerprint, [], true, new Date());
      await f.store.executions.observe(
        acceptance.execution,
        acceptance.fingerprint,
        complete ? "terminal" : "canceled",
        1,
        new Date(),
        { status: complete ? "completed" : "canceled" },
      );
      const manifest = await f.store.exports.seal(acceptance.execution, new Date());
      expect(manifest.objects).toEqual([]);
      expect(manifest.completeness).toBe(complete ? "complete" : "lost");
      expect(manifest.errors).toEqual(complete ? [] : ["publication_incomplete"]);
      expect((await f.store.executions.get(acceptance.execution))?.finalizedAt).toBeNull();
      await f.store.executions.acknowledge(acceptance.execution, acceptance.fingerprint, new Date());
      await f.store.executions.finalize(acceptance.execution, new Date());
    } finally {
      await f.dispose();
    }
  },
);

test.each([false, true])("runtime loss seals legacy staged publications (terminal observed: %s)", async (terminal) => {
  const f = await executionFixture(
    (source) => {
      serviceExecutionTemplate(source);
      source.spec.operations.run!.outputRoots = ["/outputs"];
      source.spec.limits.exportRetentionSeconds = 1;
    },
    {
      capabilities: [
        "explicit-start",
        "exact-exit",
        "targeted-cancel",
        "request-lookup",
        "deduplicated-accept",
        "stop-before-export",
        "unknown-outcome",
        "explicit-publication",
      ],
    },
  );
  try {
    const acceptance = f.acceptance();
    await f.store.executions.accept(
      acceptance,
      new Date(),
      executionConversationIdentity(acceptance.execution.requestId),
    );
    await f.store.executions.claim(acceptance.execution, new Date());
    const bytes = Buffer.from("partial result");
    const capacity = {
      workspace: { bytes: 4194304, files: 16 },
      principal: { bytes: 8388608, files: 32 },
      instance: { bytes: 16777216, files: 64 },
      freeDisk: { bytes: 33554432, files: 128, headroomBytes: 0, headroomFiles: 0 },
    };

    await f.store.exports.publish(
      acceptance.execution,
      acceptance.fingerprint,
      [
        {
          publicationId: randomUUID(),
          name: "partial.txt",
          mediaType: "text/plain",
          bytes,
          sizeBytes: bytes.length,
          digest: `sha256:${sha256Hex(bytes)}`,
        },
      ],
      false,
      new Date(),
      capacity,
    );
    if (terminal)
      await f.store.executions.observe(acceptance.execution, acceptance.fingerprint, "terminal", 1, new Date(), {
        status: "completed",
        finalResponse: "retained result",
      });
    await f.store.endWorkspaceRuntime(f.id, acceptance.execution.incarnationId, new Date());
    const record = await f.store.executions.get(acceptance.execution);
    expect(record?.collection).toMatchObject({ completeness: "partial", errors: ["runtime_lost"] });
    if (!record?.collection) throw Error("Missing loss receipt");
    if (terminal) expect(record.outcome).toMatchObject({ status: "completed", finalResponse: "retained result" });
    await f.store.managed.requests.completeCleanup(f.id);
    expect((await f.store.executions.get(acceptance.execution))?.collection?.cleanupState).toBe("complete");
    const after = new Date(new Date(record.collection.expiresAt).getTime() + 1);
    await f.store.exports.prune(after);
    const rows = await f.context.db.select().from(f.context.tables.exportObjects);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toBeNull();
  } finally {
    await f.dispose();
  }
});
