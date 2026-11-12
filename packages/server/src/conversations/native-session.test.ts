import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { digestOf } from "@pstdio/pocketcoder-contracts";
import { serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { buildServer } from "../app";
import { processDispatchFixture } from "../control-channel/process-dispatch-fixture.test";

test("native execution replay commits structured history before acknowledgement after controller recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-native-controller-"));
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = Number(listener.port);
  await listener.stop(true);
  const f = await processDispatchFixture((source) => {
    serviceExecutionTemplate(source, port);
    const operation = source.spec.operations.run;
    if (!operation) throw new Error("Missing operation");
    source.spec.operations = {
      message: {
        ...operation,
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    };
    const service = source.spec.services.agent;
    if (!service) throw new Error("Missing service");
    service.healthPath = "/healthz";
    for (const route of service.routes) route.maxResponseBytes = 8 * 1024 * 1024;
    service.process = {
      command: [
        process.execPath,
        resolve(import.meta.dir, "../../../supervisor/src/index.ts"),
        "session",
        "serve",
        "echo",
      ],
      env: { POCKETCODER_SESSION_DIRECTORY: root, POCKETCODER_SESSION_PORT: String(port) },
    };
  });
  try {
    const health = () =>
      fetch(`http://127.0.0.1:${port}/healthz`).then(
        (response) => response.ok,
        () => false,
      );
    const deadline = Date.now() + 5000;
    while (!(await health()) && Date.now() < deadline) await Bun.sleep(10);
    expect(await health()).toBe(true);
    const { fingerprint: _, ...base } = f.acceptance();
    const facts = { ...base, operation: "message", input: { message: "**Native** Unicode å\n<ot>literal</ot>" } };
    const acceptance = { ...facts, fingerprint: digestOf(facts) };
    const identity = {
      schema: "pocketcoder.conversation/v2" as const,
      authority: "external" as const,
      conversation_id: crypto.randomUUID(),
      request_id: acceptance.execution.requestId,
      turn_id: acceptance.execution.requestId,
      request_fingerprint: digestOf(facts).slice(7),
    };
    const liveEvents: unknown[] = [];
    const unsubscribe = f.liveTurns.subscribe(f.id, (event) => liveEvents.push(event));
    await f.store.executions.accept(acceptance, new Date(), identity);
    await f.dispatcher.tick();
    await f.dispatcher.drain();
    await f.waitFor(async () => liveEvents.length >= 2);
    expect(liveEvents).toContainEqual(expect.objectContaining({ type: "turn" }));
    unsubscribe();
    // Startup must leave execution-owned turns for their producer's exact replay.
    expect(await f.store.recordInterruptedTurns(new Date())).toBe(0);
    for (let round = 0; round < 4; round++) {
      await f.dispatcher.tick();
      await f.dispatcher.drain();
    }
    const record = await f.store.executions.get(acceptance.execution);
    expect(record?.acknowledgedAt).toBeString();
    const document = await f.store.getConversation(f.principal.id, identity.conversation_id);
    expect(document?.recordCount).toBe(1);
    const messages = await f.store.readConversationMessages(document?.id as string, 0, 100);
    expect(messages.find((message) => message.role === "assistant")?.parts).toEqual([
      { type: "text", text: `echo: ${facts.input.message}` },
    ]);
    expect(messages.at(-1)?.identity?.fact).toEqual({ type: "turn_terminal", outcome: "completed" });
    const key = issueMachineKey("native-cli");
    await f.store.insertMachineKey({
      id: key.id,
      principalId: f.principal.id,
      secretDigest: key.secretDigest,
      scopes: [],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      lastUsedAt: null,
    });
    const built = buildServer({
      store: f.store,
      driver: new DockerDriver(),
      pepper: "native-cli",
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://localhost",
    });
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: built.app.fetch,
    });
    const client = new PocketCoderClient({ baseUrl: listener.url.toString(), apiKey: key.token });
    const conversationId = crypto.randomUUID();
    const request = {
      requestId: crypto.randomUUID(),
      conversationId,
      message: "**CLI** å <ot>literal</ot>",
      files: [],
    };
    await client.workspaceRequests.submit(f.id, request);
    await Bun.write(join(root, `chat-${f.id}.json`), JSON.stringify({ conversationId, pending: request }));
    let pumping = true;
    const pump = (async () => {
      while (pumping) {
        await f.dispatcher.tick();
        await f.dispatcher.drain();
        await Bun.sleep(10);
      }
    })();
    const runCli = async (args: string[]) => {
      const process = Bun.spawn(
        [Bun.which("bun")!, "--no-env-file", resolve(import.meta.dir, "../../../cli/src/index.ts"), ...args],
        {
          cwd: root,
          env: {
            ...globalThis.process.env,
            POCKETCODER_URL: listener.url.toString(),
            POCKETCODER_KEY: key.token,
            POCKETCODER_STATE_DIR: root,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      return out;
    };
    try {
      const output = await runCli([
        "workspaces",
        "chat",
        "--id",
        f.id,
        "--message",
        request.message,
        "--json",
        "--poll-interval-ms",
        "100",
      ]);
      expect(output).toContain("**CLI** å <ot>literal</ot>");
      expect(output).toContain('"type":"text"');
      expect((await client.workspaceRequests.list(f.id, { conversationId })).items).toHaveLength(1);
      expect((await Bun.file(join(root, `chat-${f.id}.json`)).json()).pending).toBeUndefined();
      const reattached = await runCli([
        "workspaces",
        "attach",
        "--id",
        f.id,
        "--conversation",
        conversationId,
        "--json",
      ]);
      expect(reattached).toContain("echo: **CLI**");
    } finally {
      pumping = false;
      await pump;
      await listener.stop(true);
      await built.executionDispatcher.stop();
    }
  } finally {
    await f.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
