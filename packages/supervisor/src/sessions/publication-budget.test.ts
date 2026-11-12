import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionPublicationPolicy, type WorkloadTemplate } from "@pstdio/pocketcoder-contracts";
import { envelope } from "./fixture.test";
import { SessionProducer } from "./producer";

test("native terminal observations fit the relay with escaped final text and many UTF-8 filenames", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-publication-budget-")));
  const template = (await Bun.file(
    new URL("../../../../examples/templates/pi-harness.json", import.meta.url),
  ).json()) as WorkloadTemplate;
  const responseBytes = 5.5 * 1024 * 1024;
  const operation = template.spec.operations.message;
  if (!operation) throw new Error("Missing message operation");
  operation.outputRoots = [root];
  for (const service of Object.values(template.spec.services))
    for (const route of service.routes) route.maxResponseBytes = responseBytes;
  const policy = executionPublicationPolicy(template.spec, "message");
  if (!policy) throw new Error("Missing publication policy");
  const full = join(root, "full.bin"),
    empty = join(root, "empty.bin");
  await writeFile(full, Buffer.alloc(policy.bytes, 42));
  await writeFile(empty, "");
  const finalResponse = "\0".repeat(240 * 1024);
  const producer = new SessionProducer(join(root, "journal"), async (run) => {
    const publish = run.publishFile;
    if (!publish) throw new Error("Missing publication capability");
    publish({ path: full, name: "😀".repeat(120), mediaType: "application/octet-stream" });
    for (let index = 1; index < 100; index++)
      publish({ path: empty, name: `${"😀".repeat(120)}${index}`, mediaType: "application/octet-stream" });
    run.emit("answer", "assistant", [{ type: "text", text: finalResponse }], { type: "final_response" });
    for (let index = 0; index < 100; index++) {
      try {
        run.emit(`tool:${index}`, "tool", [
          {
            type: "tool",
            call_id: String(index),
            name: "read",
            status: "completed",
            input: {},
            output: "x".repeat(48 * 1024),
          },
        ]);
      } catch {
        break;
      }
    }
  });
  const input = { ...envelope(), publicationPolicy: policy };
  try {
    await producer.accept(input);
    await producer.quiesce();
    const snapshot = await producer.lookup(input.acceptance.execution);
    expect(snapshot).toMatchObject({ outcome: { status: "completed", finalResponse } });
    const json = JSON.stringify(snapshot);
    expect(Buffer.byteLength(json)).toBeLessThan(responseBytes);
    expect(Buffer.byteLength(JSON.stringify({ body_b64: Buffer.from(json).toString("base64") }))).toBeLessThan(
      12 * 1024 * 1024,
    );
  } finally {
    await producer.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
