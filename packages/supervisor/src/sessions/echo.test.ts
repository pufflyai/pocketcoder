import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf, type InputObjectReference } from "@pstdio/pocketcoder-contracts";
import { echoRunner } from "./echo";
import { envelope } from "./fixture.test";
import { SessionProducer } from "./producer";

test("native Echo reads immutable file IDs and retains typed tool output and attachment metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-native-files-"));
  try {
    const input = envelope();
    const fileId = crypto.randomUUID();
    const text = "å\n<ot>literal</ot>";
    await Bun.write(join(directory, fileId), text);
    const file: InputObjectReference = {
      workspaceId: input.acceptance.execution.workspaceId,
      objectVersion: digestOf("version"),
      fileId,
      name: "original name.txt",
      mediaType: "text/plain",
      sizeBytes: Buffer.byteLength(text),
      digest: digestOf(text),
      visibility: "ready",
    };
    const inputs = { workspaceId: file.workspaceId, incarnationId: "test", objects: [file] };
    const { fingerprint: _, ...facts } = input.acceptance;
    const acceptance = { ...facts, inputs: { ...inputs, digest: digestOf(inputs) } };
    const producer = new SessionProducer(join(directory, "journal"), echoRunner);
    await producer.accept({
      ...input,
      acceptance: { ...acceptance, fingerprint: digestOf(acceptance) },
      inputDirectory: directory,
    });
    await producer.quiesce();
    const result = await producer.lookup(acceptance.execution);
    if (result.phase === "absent") throw new Error("Missing request");
    expect(result.outcome).toMatchObject({ status: "completed" });
    expect(result.messages?.find((m) => m.role === "tool")?.parts?.[0]).toMatchObject({
      type: "tool",
      name: "read",
      status: "completed",
      call_id: `${acceptance.execution.requestId}:${fileId}`,
      output: { text, name: file.name, sizeBytes: file.sizeBytes },
      output_text: text,
    });
    expect(result.messages?.[0]?.parts?.[1]).toMatchObject({ type: "file", file_id: fileId, name: file.name });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
