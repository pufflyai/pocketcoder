import { join } from "node:path";
import type { SessionRunner } from "./producer";

export const echoRunner: SessionRunner = async ({ acceptance, emit, signal, inputDirectory }) => {
  signal.throwIfAborted();
  const lines = [`echo: ${String(acceptance.input.message)}`];
  for (const file of acceptance.inputs.objects) {
    if (!inputDirectory) throw new Error("Immutable input directory is missing");
    const callId = `${acceptance.execution.requestId}:${file.fileId}`;
    const input = { file_id: file.fileId, name: file.name };
    emit(`read:${file.fileId}`, "tool", [
      {
        type: "tool",
        call_id: callId,
        name: "read",
        input,
        status: "running",
      },
    ]);
    const bytes = await Bun.file(join(inputDirectory, file.fileId)).bytes();
    signal.throwIfAborted();
    const text = file.mediaType.startsWith("text/") ? new TextDecoder().decode(bytes.slice(0, 200 * 1024)) : null;
    const output = {
      name: file.name,
      sizeBytes: bytes.length,
      digest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
      text,
      truncated: bytes.length > 200 * 1024,
    };
    emit(`read:${file.fileId}`, "tool", [
      {
        type: "tool",
        call_id: callId,
        name: "read",
        input,
        output,
        output_text: text ?? `${output.sizeBytes} bytes (${output.digest})`,
        status: "completed",
      },
    ]);
    lines.push(`${file.name}: ${text ?? `${output.sizeBytes} bytes (${output.digest})`}`);
  }
  emit("response", "assistant", [{ type: "text", text: lines.join("\n") }], { type: "final_response" });
};
