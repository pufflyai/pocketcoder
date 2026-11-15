import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@pstdio/pocketcoder-contracts";
import { envelope } from "./fixture.test";
import { piRunner } from "./pi";
import { SessionProducer } from "./producer";

test("a native Pi subprocess publishes through the installed command without putting bytes in its answer", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-pi-publication-")));
  const file = join(directory, "report.csv");
  const fixture = join(directory, "rpc.ts");
  const command = new URL("../index.ts", import.meta.url).pathname;
  const bytes = Buffer.from("account,total\n1,42\n");
  await writeFile(file, bytes);
  await writeFile(
    fixture,
    `
    for await (const line of console) {
      if (JSON.parse(line).type !== 'prompt') continue;
      const child = Bun.spawnSync([process.execPath, ${JSON.stringify(command)}, 'session', 'publish-file', '--file', ${JSON.stringify(file)}, '--media-type', 'text/csv'], { env: process.env });
      if (child.exitCode !== 0) throw new Error(child.stderr.toString());
      const receipt = JSON.parse(child.stdout.toString());
      console.log(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:JSON.stringify(receipt)}], stopReason:'stop'}}));
      console.log(JSON.stringify({type:'agent_settled'}));
    }
  `,
  );
  const producer = new SessionProducer(
    join(directory, "requests"),
    piRunner([process.execPath, fixture], join(directory, "pi")),
  );
  const input = { ...envelope(), publicationPolicy: { roots: [directory], bytes: 1024, files: 2 } };
  try {
    await producer.accept(input);
    await producer.quiesce();
    const snapshot = await producer.lookup(input.acceptance.execution);
    expect(snapshot).toMatchObject({
      phase: "terminal",
      outcome: { status: "completed" },
      publication: { complete: true, objects: [{ name: "report.csv", digest: `sha256:${sha256Hex(bytes)}` }] },
    });
    const answer =
      "messages" in snapshot && snapshot.messages?.find((message) => message.identity?.fact?.type === "final_response");
    expect(answer && JSON.parse(answer.content)).toMatchObject({
      state: "staged",
      name: "report.csv",
      sizeBytes: bytes.length,
    });
    expect(JSON.stringify(answer)).not.toContain(bytes.toString("base64"));
  } finally {
    await producer.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
