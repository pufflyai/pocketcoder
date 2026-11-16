import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelopeWithFiles } from "./fixture.test";
import { SessionProducer } from "./producer";

test.each([
  { name: "legacy manifest", indices: undefined, expected: [0, 1] },
  { name: "new upload only", indices: [1], expected: [1] },
  { name: "no new uploads", indices: [], expected: [] },
  { name: "user-selected order", indices: [1, 0], expected: [1, 0] },
])(
  "$name keeps historical files available without attaching them to the current user message",
  async ({ indices, expected }) => {
    const directory = await mkdtemp(join(tmpdir(), "pc-retained-metadata-"));
    const input = envelopeWithFiles(["earlier.txt", "new.txt"]);
    const files = input.acceptance.inputs.objects;
    const producer = new SessionProducer(directory, async ({ acceptance, emit }) => {
      emit("inventory", "assistant", [
        { type: "text", text: acceptance.inputs.objects.map((file) => file.name).join(",") },
      ]);
    });
    try {
      const request = { ...input, requestInputIds: indices?.map((index) => files[index]!.fileId) };
      await producer.accept(request);
      await producer.quiesce();
      const result = await producer.lookup(input.acceptance.execution);
      if (result.phase === "absent") throw new Error("Missing request");
      expect(
        result.messages
          ?.find((message) => message.role === "user")
          ?.parts?.filter((part) => part.type === "file")
          .map((part) => part.file_id),
      ).toEqual(expected.map((index) => files[index]!.fileId));
      expect(result.messages?.find((message) => message.role === "assistant")?.content).toBe("earlier.txt,new.txt");
      expect(await producer.accept(request)).toEqual(result);
    } finally {
      await producer.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  { name: "foreign input", ids: (id: string) => [id, crypto.randomUUID()] },
  { name: "duplicate input", ids: (id: string) => [id, id] },
])("$name metadata cannot select files outside the frozen request inventory", async ({ ids }) => {
  const directory = await mkdtemp(join(tmpdir(), "pc-input-selection-"));
  const input = envelopeWithFiles(["accepted.txt"]);
  const producer = new SessionProducer(directory, async () => {});
  try {
    const request = { ...input, requestInputIds: ids(input.acceptance.inputs.objects[0]!.fileId) };
    await expect(producer.accept(request)).rejects.toThrow("Invalid request input IDs");
    expect((await producer.lookup(input.acceptance.execution)).phase).toBe("absent");
  } finally {
    await producer.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
