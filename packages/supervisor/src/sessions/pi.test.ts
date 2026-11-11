import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelope } from "./fixture.test";
import { piRunner } from "./pi";
import { SessionProducer } from "./producer";

test("native cancellation stops real process descendants before the producer reports completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-native-pi-group-"));
  const marker = join(directory, "descendant");
  const fixture = join(directory, "rpc.ts");
  await Bun.write(
    fixture,
    `const marker=${JSON.stringify(marker)};Bun.spawn([process.execPath,'-e',\`process.on('SIGTERM',()=>{});setInterval(()=>Bun.write(\${JSON.stringify(marker)},String(Date.now())),5)\`],{stdout:'ignore',stderr:'ignore'});for await(const line of console){const command=JSON.parse(line);if(command.type==='prompt'){console.log(JSON.stringify({type:'tool_execution_start',toolCallId:'sleep',toolName:'bash',args:{command:'sleep 100'}}));}if(command.type==='abort'){console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],stopReason:'aborted'}}));console.log(JSON.stringify({type:'agent_settled'}));}}`,
  );
  const producer = new SessionProducer(
    join(directory, "requests"),
    piRunner([process.execPath, fixture], join(directory, "pi")),
  );
  const input = envelope();
  try {
    await producer.accept(input);
    const deadline = Date.now() + 2000;
    while (!(await Bun.file(marker).exists())) {
      if (Date.now() > deadline) throw new Error("Descendant did not start");
      await Bun.sleep(5);
    }
    const result = await producer.cancel(input.acceptance.execution, input.acceptance.fingerprint);
    expect(result).toMatchObject({ phase: "canceled", outcome: { status: "canceled" } });
    const stopped = await Bun.file(marker).text();
    await Bun.sleep(50);
    expect(await Bun.file(marker).text()).toBe(stopped);
    expect("messages" in result && result.messages?.find((m) => m.role === "tool")?.parts?.[0]).toMatchObject({
      status: "canceled",
    });
  } finally {
    await producer.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
