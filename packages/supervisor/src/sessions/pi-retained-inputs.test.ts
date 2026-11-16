import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelopeWithFiles } from "./fixture.test";
import { piRunner } from "./pi";
import { seedPiSession } from "./pi-history";
import { SessionProducer } from "./producer";

test("Pi reopens a retained input after its earlier execution projection was removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-pi-retained-"));
  const input = envelopeWithFiles(["earlier.txt"]);
  const fileId = input.acceptance.inputs.objects[0]!.fileId;
  const previousPath = `/run/pocketcoder/inputs/${randomUUID()}/${fileId}`;
  const unrelated = `/run/pocketcoder/inputs/${randomUUID()}/${randomUUID()}`;
  const current = join(directory, "projection");
  const content = "retained immutable bytes Å 東京";
  await Bun.write(join(current, fileId), content);
  const sessions = join(directory, "pi");
  const session = join(sessions, `${input.conversationIdentity.conversation_id}.jsonl`);
  await Bun.write(join(sessions, ".keep"), "");
  seedPiSession(session, [
    {
      role: "user",
      content: `Read these immutable input files:\n${previousPath} (earlier.txt)\nUnrelated text: ${unrelated}`,
    },
  ]);
  const seeded = (await readFile(session, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const signed = {
    type: "message",
    id: "thinking",
    parentId: seeded[1].id,
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: previousPath, thinkingSignature: "opaque-signature" }],
    },
  };
  const blocks = {
    type: "message",
    id: "blocks",
    parentId: signed.id,
    message: {
      role: "user",
      content: [
        { type: "text", text: previousPath },
        { type: "image", data: "untouched-image" },
      ],
    },
  };
  const before = [...seeded, signed, blocks];
  await Bun.write(session, before.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const fixture = join(directory, "rpc.ts");
  await Bun.write(
    fixture,
    `
import { createHash } from 'node:crypto';
const session = Bun.argv[Bun.argv.indexOf('--session') + 1];
setInterval(() => {}, 1000);
for await (const line of console) {
  const command = JSON.parse(line);
  if (command.type !== 'prompt') continue;
  const entries = (await Bun.file(session).text()).trim().split('\\n').map((row) => JSON.parse(row));
  const text = entries.find((entry) => entry.message?.role === 'user').message.content;
  const path = text.split('\\n')[1].split(' ')[0];
  try {
  const bytes = await Bun.file(path).bytes();
  const digest = createHash('sha256').update(bytes).digest('hex');
  console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:digest}],stopReason:'stop'}}));
  } catch (error) { console.log(JSON.stringify({type:'response',command:'prompt',success:false,error:String(error)})); }
  console.log(JSON.stringify({type:'agent_settled'}));
}
`,
  );
  const producer = new SessionProducer(join(directory, "requests"), piRunner([process.execPath, fixture], sessions));
  try {
    await producer.accept({ ...input, inputDirectory: current });
    await producer.quiesce();
    const result = await producer.lookup(input.acceptance.execution);
    expect(result).toMatchObject({ phase: "terminal", outcome: { status: "completed" } });
    if (result.phase === "absent") throw new Error("Missing request");
    expect(result.messages?.find((message) => message.role === "assistant")?.content).toBe(
      createHash("sha256").update(content).digest("hex"),
    );
    const after = (await readFile(session, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual({
      ...before[1],
      message: {
        ...before[1].message,
        content: before[1].message.content.replace(previousPath, join(current, fileId)),
      },
    });
    expect(after[1].message.content).toContain(unrelated);
    expect(after[2]).toEqual(signed);
    expect(after[3]).toEqual({
      ...blocks,
      message: {
        ...blocks.message,
        content: [{ type: "text", text: join(current, fileId) }, blocks.message.content[1]],
      },
    });
  } finally {
    await producer.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  { name: "malformed JSON", history: (header: string) => header + '\n{"unfinished":', expected: "JSON" },
  {
    name: "unsupported format",
    history: (header: string) => header.replace('"version":3', '"version":2'),
    expected: "Unsupported Pi session format",
  },
])("$name prevents a Pi spawn and leaves its private session unchanged", async ({ history, expected }) => {
  const directory = await mkdtemp(join(tmpdir(), "pc-pi-invalid-history-"));
  const input = envelopeWithFiles(["retained.txt"]);
  const path = join(directory, `${input.conversationIdentity.conversation_id}.jsonl`);
  const original = history(JSON.stringify({ type: "session", version: 3, id: randomUUID() }));
  const marker = join(directory, "spawned");
  const script = join(directory, "rpc.ts");
  await Bun.write(path, original);
  await Bun.write(script, `await Bun.write(${JSON.stringify(marker)}, "spawned");`);
  const producer = new SessionProducer(join(directory, "journal"), piRunner([process.execPath, script], directory));
  try {
    await producer.accept({ ...input, inputDirectory: join(directory, "projection") });
    await producer.quiesce();
    const result = await producer.lookup(input.acceptance.execution);
    expect(result).toMatchObject({ phase: "terminal", outcome: { status: "failed" } });
    if (result.phase === "absent") throw new Error("Missing request");
    expect(
      result.messages
        ?.flatMap((message) => message.parts ?? [])
        .filter((part) => part.type === "error")
        .map((part) => part.message)
        .join(" "),
    ).toContain(expected);
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await producer.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
