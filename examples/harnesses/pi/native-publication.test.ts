import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { digestOf, sha256Hex } from "@pstdio/pocketcoder-contracts";
import { piRunner, SessionProducer, supervisorEntrypoint } from "@pstdio/pocketcoder-supervisor/testing";
import { writeModelConfig } from "./starter/src/model-route";

test("the pinned Pi CLI publishes a generated report using its real Bash tool", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-real-pi-publish-")));
  const bytes = Buffer.from("native report\n");
  const path = join(root, "report.txt");
  const bundle = join(root, "index.js");
  await writeFile(path, bytes);
  const built = await Bun.build({
    entrypoints: [supervisorEntrypoint],
    outdir: root,
    target: "bun",
  });
  expect(built.success).toBe(true);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, bundle, "session", "publish-file", "--file", path, "--media-type", "text/plain"]
    .map(quote)
    .join(" ");
  const bearer = randomUUID();
  let calls = 0;
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${bearer}`);
      calls++;
      const body = (await request.json()) as { messages: { role: string }[] };
      const finished = body.messages.some((message) => message.role === "tool");
      const delta = finished
        ? { content: "Report published." }
        : {
            tool_calls: [
              {
                index: 0,
                id: "publish-report",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command }) },
              },
            ],
          };
      const chunk = {
        id: "publish-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "publication-test",
        choices: [{ index: 0, delta, finish_reason: finished ? "stop" : "tool_calls" }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const agentDir = join(root, "agent");
  await writeModelConfig(agentDir, {
    url: `http://127.0.0.1:${gateway.port}/v1`,
    model: "publication-test",
    api: "openai-completions",
    bearerFile: "unused",
    contextWindow: 128000,
    maxTokens: 4096,
  });
  const piPackage = require.resolve("@earendil-works/pi-coding-agent/package.json");
  const pi = join(dirname(piPackage), (await Bun.file(piPackage).json()).bin.pi);
  const wrapper = join(root, "run.ts");
  await writeFile(
    wrapper,
    `
    const child = Bun.spawn([process.execPath, ${JSON.stringify(pi)}, '--provider', 'pocketcoder-gateway', '--model', 'publication-test', '--approve', '--offline', ...process.argv.slice(2)], {
      env: {...process.env, PI_CODING_AGENT_DIR: ${JSON.stringify(agentDir)}, PI_GATEWAY_BEARER: ${JSON.stringify(bearer)}}, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'
    }); process.exit(await child.exited);
  `,
  );
  const producer = new SessionProducer(
    join(root, "requests"),
    piRunner([process.execPath, wrapper], join(root, "sessions")),
  );
  const execution = {
    workspaceId: randomUUID(),
    incarnationId: "fixture",
    owner: "conversation-request" as const,
    requestId: randomUUID(),
  };
  const inputs = { workspaceId: execution.workspaceId, incarnationId: "fixture", objects: [] };
  const facts = {
    execution,
    callerPrincipalId: randomUUID(),
    templateDigest: digestOf("template"),
    adapterDigest: digestOf("adapter"),
    operation: "message",
    input: { message: "Publish the prepared report." },
    inputs: { ...inputs, digest: digestOf(inputs) },
    bindingSetDigest: digestOf([]),
  };
  const fingerprint = digestOf(facts);
  try {
    await producer.accept({
      acceptance: { ...facts, fingerprint },
      conversationIdentity: {
        schema: "pocketcoder.conversation/v2",
        authority: "external",
        conversation_id: randomUUID(),
        request_id: randomUUID(),
        turn_id: execution.requestId,
        request_fingerprint: fingerprint.slice(7),
      },
      publicationPolicy: { roots: [root], bytes: 1024, files: 1 },
    });
    await producer.quiesce();
    expect(await producer.lookup(execution)).toMatchObject({
      outcome: { status: "completed", finalResponse: "Report published." },
      publication: {
        complete: true,
        objects: [
          { name: "report.txt", digest: `sha256:${sha256Hex(bytes)}`, contentBase64: bytes.toString("base64") },
        ],
      },
    });
    expect(calls).toBe(2);
  } finally {
    await producer.shutdown();
    await gateway.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
