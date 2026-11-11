// RPC uses LF records. Unicode line separators are ordinary message content.
export async function* jsonLines(stream: ReadableStream<Uint8Array>) {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Pi protocol record exceeds 1 MiB");
      if (line.trim()) yield JSON.parse(line) as unknown;
      newline = buffer.indexOf("\n");
    }
    if (Buffer.byteLength(buffer) > 1024 * 1024) throw new Error("Pi protocol record exceeds 1 MiB");
  }
  if (buffer.trim()) throw new Error("Pi exited with an incomplete protocol record");
}
