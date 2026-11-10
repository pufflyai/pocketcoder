function recordText(source: string) {
  let record: unknown;
  try {
    // Onefin escapes content newlines, so terminal row wrapping can be removed.
    record = JSON.parse(source.replace(/[\r\n]/g, ""));
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object" || !("type" in record)) return undefined;
  switch (record.type) {
    case "text":
    case "text_delta":
      return "text" in record && typeof record.text === "string" ? record.text : undefined;
    case "error":
      return "message" in record && typeof record.message === "string" ? record.message : undefined;
    case "tool_start":
    case "tool_end":
      return "";
    default:
      return undefined;
  }
}

export function onefinTranscriptText(content: string) {
  const frames = /<ot>([\s\S]*?)<\/ot>/g;
  const records = [...content.matchAll(frames)];
  if (!records.length || content.replace(frames, "").trim()) return content;
  const text: string[] = [];
  for (const match of records) {
    const part = recordText(match[1] ?? "");
    if (part === undefined) return content;
    text.push(part);
  }
  return text.join("");
}
