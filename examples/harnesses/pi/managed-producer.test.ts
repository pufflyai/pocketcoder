import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ChatRequest, PI_FIXTURE_CONTENT, PI_INTERRUPT_PROMPT, startFakePiGateway } from "./fake-gateway";
import { createExecutionAdapter } from "./starter/src/execution-adapter";

// The real pinned Pi CLI answers through the deterministic gateway fixture; no paid model.
const BEARER = "workspace-scoped-fixture-bearer";
const requests: ChatRequest[] = [];
let root = "";
let gateway: ReturnType<typeof startFakePiGateway>;
let server: ReturnType<typeof Bun.serve>;
let adapter: ReturnType<typeof createExecutionAdapter>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-managed-"));
  gateway = startFakePiGateway(BEARER, (body) => requests.push(body));
  await writeFile(join(root, "bearer"), `${BEARER}\n`);
  adapter = createExecutionAdapter(await config(join(root, "bearer")));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: adapter.fetch, idleTimeout: 60 });
});
afterAll(async () => {
  adapter.stop();
  await adapter.settled();
  server.stop(true);
  gateway.stop(true);
  await rm(root, { recursive: true, force: true });
});

async function config(bearerFile: string) {
  const { configFromEnv } = await import("./starter/src/execution-adapter");
  return configFromEnv({
    PI_CLI: join(dirname(require.resolve("@earendil-works/pi-coding-agent/package.json")), "dist/cli.js"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_SESSION_DIR: join(root, "sessions"),
    PI_WORKSPACE_DIR: root,
    PI_OUTPUT_ROOT: join(root, "outputs"),
    PI_PUBLICATION_MAX_BYTES: "4194304",
    PI_GATEWAY_URL: `http://127.0.0.1:${gateway.port}/v1`,
    PI_GATEWAY_MODEL: "pocketcoder-test",
    PI_GATEWAY_BEARER_FILE: bearerFile,
  });
}

type Fact = {
  phase: string;
  outcome: { status?: string; reasonCode?: string; finalResponse?: string | null };
  publication: { complete: boolean; objects: Record<string, unknown>[] };
};
const json = async (reply: Response) => (await reply.json()) as Fact;

function acceptance(message: string) {
  const execution = {
    workspaceId: randomUUID(),
    incarnationId: "fixture",
    owner: "conversation-request",
    requestId: randomUUID(),
  };
  return {
    execution,
    fingerprint: `sha256:${createHash("sha256")
      .update(message + execution.requestId)
      .digest("hex")}`,
    input: { message },
  };
}
const call = (action: string, body: unknown) =>
  fetch(`http://127.0.0.1:${server.port}/executions/${action}`, { method: "POST", body: JSON.stringify(body) });
const accept = (a: ReturnType<typeof acceptance>, sessionId: string) =>
  call("accept", { acceptance: a, conversationIdentity: { conversation_id: sessionId } });
async function lookup(a: ReturnType<typeof acceptance>) {
  return (await call("lookup", { execution: a.execution })).json() as Promise<Fact>;
}
async function until(a: ReturnType<typeof acceptance>, phase: string) {
  for (let i = 0; i < 300; i++) {
    const fact = await lookup(a);
    if (fact.phase === phase) return fact;
    await Bun.sleep(100);
  }
  throw new Error(`Turn never reached ${phase}`);
}

test("a turn completes from Pi's structured events, deduplicates accept and survives a lost reply", async () => {
  const sessionId = randomUUID();
  const a = acceptance("Read the fixture file.");
  const before = requests.length;
  const first = await accept(a, sessionId);
  expect(await first.json()).toMatchObject({ phase: "running", fingerprint: a.fingerprint });
  // A retried accept after a lost reply is the same execution, never a second run.
  expect((await json(await accept(a, sessionId))).phase).toBeOneOf(["running", "terminal"]);
  expect((await accept({ ...a, fingerprint: `sha256:${"0".repeat(64)}` }, sessionId)).status).toBe(409);
  const fact = await until(a, "terminal");
  expect(fact.outcome).toMatchObject({ status: "completed", finalResponse: PI_FIXTURE_CONTENT });
  expect(fact.publication).toEqual({ complete: true, objects: [] });
  // One run reads the file and answers: exactly two model calls.
  expect(requests.length - before).toBe(2);
  expect((await call("ack", { execution: a.execution, fingerprint: a.fingerprint })).status).toBe(200);
  expect((await lookup(a)).phase).toBe("terminal");

  // The next turn of the same session continues Pi's conversation.
  const next = acceptance("Read it again.");
  await accept(next, sessionId);
  await until(next, "terminal");
  const history = requests.at(-1)?.messages?.map((message) => message.role);
  expect(history?.filter((role) => role === "user")).toHaveLength(2);
}, 60_000);

test("files Pi saves in the turn's output directory are explicitly published", async () => {
  const a = acceptance("Write report.txt containing: quarterly numbers");
  await accept(a, randomUUID());
  const fact = await until(a, "terminal");
  expect(fact.outcome).toMatchObject({ status: "completed", finalResponse: "Saved report.txt" });
  const bytes = Buffer.from("quarterly numbers");
  expect(fact.publication.complete).toBe(true);
  expect(fact.publication.objects).toEqual([
    {
      publicationId: expect.any(String),
      name: "report.txt",
      mediaType: "text/plain",
      sizeBytes: bytes.length,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      contentBase64: bytes.toString("base64"),
    },
  ]);
}, 60_000);

test("a targeted cancel stops one running turn while another session's turn completes", async () => {
  const held = acceptance(PI_INTERRUPT_PROMPT);
  const sibling = acceptance("Read the fixture file.");
  await accept(held, randomUUID());
  await accept(sibling, randomUUID());
  await Bun.sleep(1500);
  const canceled = (await (
    await call("cancel", { execution: held.execution, fingerprint: held.fingerprint })
  ).json()) as Fact;
  expect(canceled).toMatchObject({
    phase: "canceled",
    outcome: { status: "canceled", reasonCode: "canceled_by_request" },
  });
  expect(canceled.publication.complete).toBe(false);
  expect((await until(sibling, "terminal")).outcome.status).toBe("completed");
  // A cancel that arrives before accept stops the turn from ever starting.
  const early = acceptance("Read the fixture file.");
  expect((await json(await call("cancel", { execution: early.execution, fingerprint: early.fingerprint }))).phase).toBe(
    "canceled",
  );
  expect((await json(await accept(early, randomUUID()))).phase).toBe("canceled");
}, 60_000);

test("a missing or rejected gateway credential ends the turn as an explicit failure", async () => {
  const missing = createExecutionAdapter(await config(join(root, "absent-bearer")));
  const a = acceptance("Read the fixture file.");
  const reply = await missing.fetch(
    new Request("http://adapter/executions/accept", {
      method: "POST",
      body: JSON.stringify({ acceptance: a, conversationIdentity: { conversation_id: randomUUID() } }),
    }),
  );
  expect(await reply.json()).toMatchObject({
    phase: "terminal",
    outcome: { status: "failed", reasonCode: "model_credential_unavailable", finalResponse: null },
  });
  await writeFile(join(root, "wrong-bearer"), "not-the-workspace-bearer\n");
  const rejected = createExecutionAdapter(await config(join(root, "wrong-bearer")));
  const b = acceptance("Read the fixture file.");
  await rejected.fetch(
    new Request("http://adapter/executions/accept", {
      method: "POST",
      body: JSON.stringify({ acceptance: b, conversationIdentity: { conversation_id: randomUUID() } }),
    }),
  );
  await rejected.settled();
  const fact = await (
    await rejected.fetch(
      new Request("http://adapter/executions/lookup", {
        method: "POST",
        body: JSON.stringify({ execution: b.execution }),
      }),
    )
  ).json();
  expect(fact).toMatchObject({ phase: "terminal", outcome: { status: "failed", reasonCode: "model_error" } });
}, 60_000);
