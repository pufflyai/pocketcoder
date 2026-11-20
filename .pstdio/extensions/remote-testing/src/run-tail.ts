// One very long line must not turn a log preview into an oversized storage record.
export function logTail(text: string) {
  return new TextDecoder()
    .decode(new TextEncoder().encode(text).slice(-16 * 1024))
    .split("\n")
    .slice(-60)
    .join("\n");
}
