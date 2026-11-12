import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, type WorkloadAcceptance } from "@pstdio/pocketcoder-contracts";
import { serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { processDispatchFixture } from "../control-channel/process-dispatch-fixture.test";

const capacity = async () => ({
  workspace: { bytes: 4194304, files: 64 },
  principal: { bytes: 8388608, files: 128 },
  instance: { bytes: 16777216, files: 256 },
  freeDisk: { bytes: 33554432, files: 512, headroomBytes: 0, headroomFiles: 0 },
});

test("a producer forgetting an observed running request leaves an uncertain outcome without a second dispatch", async () => {
  let acceptance: WorkloadAcceptance | undefined;
  let accepts = 0;
  const producer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/status") return Response.json({ status: "stable" });
      const body = (await request.json()) as {
        acceptance?: WorkloadAcceptance;
        execution?: WorkloadAcceptance["execution"];
      };
      if (path === "/executions/accept" && body.acceptance) {
        acceptance = body.acceptance;
        accepts++;
        return Response.json({
          execution: acceptance.execution,
          fingerprint: acceptance.fingerprint,
          phase: "running",
          outcome: { startedAt: new Date().toISOString() },
        });
      }
      return Response.json({ execution: body.execution, phase: "absent" });
    },
  });
  const f = await processDispatchFixture((source) => {
    serviceExecutionTemplate(source, producer.port);
    const run = source.spec.operations.run;
    if (!run) throw Error("Missing operation");
    source.spec.operations = {
      message: {
        ...run,
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    };
  });
  try {
    const keyId = randomUUID(),
      profileId = randomUUID(),
      sessionId = randomUUID();
    await f.store.insertMachineKey({
      id: keyId,
      principalId: f.principal.id,
      secretDigest: new Uint8Array([6]),
      scopes: ["admin"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
      revokedAt: null,
      lastUsedAt: null,
    });
    await f.store.publishTemplate(keyId, f.runtime.template.manifest);
    await f.store.managed.profiles.reconcile(
      f.principal.id,
      {
        [profileId]: {
          template: f.runtime.template.name,
          templateVersion: f.runtime.template.version,
          placement: "shared",
          limits: { workspacesPerOwner: 1, sessionsPerWorkspace: 20 },
          dispatchDeadlineSeconds: 600,
        },
      },
      {},
    );
    await f.store.managed.sessions.create(keyId, { sessionId, profile: profileId, owner: "test-owner" });
    await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId }, 0, {
      workspaceId: f.id,
      incarnationId: f.runtime.incarnationId,
      generation: 1,
    });
    const body = {
      requestId: randomUUID(),
      message: "run",
      attachments: [],
    };
    await f.store.managed.requests.accept(keyId, sessionId, body, { count: 2, bytes: 1048576 });
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    expect((await f.store.managed.requests.get(keyId, sessionId, body.requestId)).state).toBe("running");
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    expect(accepts).toBe(1);
    expect(await f.store.managed.requests.get(keyId, sessionId, body.requestId)).toMatchObject({
      state: "checking_outcome",
      outcome: null,
      endedAt: null,
    });
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    expect(accepts).toBe(1);
  } finally {
    await f.dispose();
    await producer.stop(true);
  }
});

test.each([1, 5, 20])(
  "native producer retains original results across later writes with %s shared sessions",
  async (count) => {
    const directory = await mkdtemp(join(tmpdir(), "pc-publication-live-"));
    const livePath = join(directory, "report.txt");
    let accepts = 0,
      acknowledgments = 0;
    const publicationId = randomUUID();
    const facts = new Map<string, unknown>();
    const producer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/status") return Response.json({ status: "stable" });
        const body = (await request.json()) as {
          acceptance?: WorkloadAcceptance;
          execution?: WorkloadAcceptance["execution"];
        };
        if (path === "/executions/ack") {
          acknowledgments++;
          return new Response("", { status: acknowledgments === 1 ? 503 : 200 });
        }
        if (path === "/executions/accept" && body.acceptance) {
          accepts++;
          const accepted = body.acceptance;
          const bytes = Buffer.from(String(accepted.input.message));
          await writeFile(livePath, bytes);
          const fact = {
            execution: accepted.execution,
            fingerprint: accepted.fingerprint,
            phase: "terminal",
            outcome: { status: "completed", finalResponse: "done" },
            publication: {
              complete: true,
              objects: [
                {
                  publicationId,
                  name: "report.txt",
                  mediaType: "text/plain",
                  sizeBytes: bytes.length,
                  digest: `sha256:${sha256Hex(bytes)}`,
                  contentBase64: bytes.toString("base64"),
                },
              ],
            },
          };
          facts.set(accepted.execution.requestId, fact);
          return Response.json(fact);
        }
        return Response.json(
          facts.get(body.execution?.requestId ?? "") ?? { execution: body.execution, phase: "absent" },
        );
      },
    });
    const f = await processDispatchFixture(
      (source) => {
        serviceExecutionTemplate(source, producer.port);
        source.spec.operations = {
          message: {
            ...source.spec.operations.run!,
            outputRoots: ["/outputs"],
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
              additionalProperties: false,
            },
          },
        };
      },
      undefined,
      {
        concurrency: 20,
        readCapacity: capacity,
        capabilities: [
          "explicit-start",
          "exact-exit",
          "targeted-cancel",
          "request-lookup",
          "deduplicated-accept",
          "stop-before-export",
          "unknown-outcome",
          "parallel-conversations",
          "explicit-publication",
        ],
      },
    );
    try {
      const keyId = randomUUID(),
        profileId = randomUUID();
      await f.store.insertMachineKey({
        id: keyId,
        principalId: f.principal.id,
        secretDigest: new Uint8Array([5]),
        scopes: ["admin"],
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
        revokedAt: null,
        lastUsedAt: null,
      });
      await f.store.publishTemplate(keyId, f.runtime.template.manifest);
      await f.store.managed.profiles.reconcile(
        f.principal.id,
        {
          [profileId]: {
            template: f.runtime.template.name,
            templateVersion: f.runtime.template.version,
            placement: "shared",
            limits: { workspacesPerOwner: 1, sessionsPerWorkspace: 20 },
            dispatchDeadlineSeconds: 600,
          },
        },
        {},
      );
      const sessions: string[] = [];
      const requestId = randomUUID();
      const deadline = new Date(Date.now() + 60000).toISOString();
      for (let i = 0; i < count; i++) {
        const sessionId = randomUUID();
        sessions.push(sessionId);
        await f.store.managed.sessions.create(keyId, { sessionId, profile: profileId, owner: "test-owner" });
        await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId }, 0, {
          workspaceId: f.id,
          incarnationId: f.runtime.incarnationId,
          generation: 1,
        });
        await f.store.managed.requests.accept(
          keyId,
          sessionId,
          { requestId, message: "original", attachments: [] },
          { count: 2, bytes: 1048576 },
        );
      }
      for (let i = 0; i < 3; i++) {
        await f.dispatcher.tick();
        await f.dispatcher.drain();
      }
      expect(accepts).toBe(count);
      expect(acknowledgments).toBe(count + 1);
      for (const sessionId of sessions)
        expect(await f.store.managed.requests.get(keyId, sessionId, requestId)).toMatchObject({
          state: "terminal",
          outcome: "completed",
          finalResponse: "done",
          collection: { completeness: "complete" },
        });
      const sessionId = sessions[0]!;
      const first = await f.store.managed.requests.get(keyId, sessionId, requestId);
      await f.store.managed.requests.accept(
        keyId,
        sessionId,
        { requestId: randomUUID(), message: "changed by later turn", attachments: [] },
        { count: 2, bytes: 1048576 },
      );
      await f.dispatcher.tick();
      await f.dispatcher.drain();
      expect(await readFile(livePath, "utf8")).toBe("changed by later turn");
      const object = first.collection.objects[0]!;
      expect(Buffer.from(await f.store.managed.files.content(keyId, sessionId, object.exportId)).toString()).toBe(
        "original",
      );
      expect(f.dispatchFailed).toBe(false);
    } finally {
      await f.dispose();
      await producer.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
