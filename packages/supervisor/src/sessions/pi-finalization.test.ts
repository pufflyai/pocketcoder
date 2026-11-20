import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelope } from "./fixture.test";
import { piRunner } from "./pi";
import { SessionProducer } from "./producer";

test("an explicit finalization grace retains a real upload after the normal cancellation bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-finalization-"));
  let uploaded = false;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.text();
      await Bun.sleep(5500);
      uploaded = true;
      return new Response();
    },
  });
  const rpc = join(directory, "rpc.ts");
  await Bun.write(
    rpc,
    `for await (const line of console) { const c=JSON.parse(line); if(c.type==='abort') { await fetch('http://127.0.0.1:${server.port}',{method:'PUT',body:'results'}); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'retained-results'}],stopReason:'stop'}})); console.log(JSON.stringify({type:'agent_settled'})); } }`,
  );
  const producer = new SessionProducer(
    join(directory, "requests"),
    piRunner([process.execPath, rpc], join(directory, "pi"), 6000),
  );
  const input = envelope();
  try {
    await producer.accept(input);
    await Bun.sleep(100);
    const result = await producer.cancel(input.acceptance.execution, input.acceptance.fingerprint);
    expect(uploaded).toBe(true);
    expect(result).toMatchObject({
      phase: "canceled",
      outcome: { status: "canceled", finalResponse: "retained-results" },
    });
  } finally {
    await producer.shutdown();
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
