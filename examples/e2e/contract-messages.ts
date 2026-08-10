export function messageList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "messages" in value &&
    Array.isArray(value.messages)
  ) {
    return value.messages;
  }
  return [];
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => textContent(item))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "message", "delta"]) {
    const text = textContent(record[key]);
    if (text) return text;
  }
  return "";
}

function isAssistantMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return [message.role, message.type, message.sender].some(
    (kind) => kind === "assistant" || kind === "agent",
  );
}

export function responseText(messages: unknown[], baselineLength: number): string {
  return messages
    .slice(baselineLength)
    .filter(isAssistantMessage)
    .map((message) => textContent(message))
    .filter(Boolean)
    .join("\n");
}

export function messageId(value: unknown): number {
  if (typeof value !== "object" || value === null || !("id" in value)) return -1;
  return typeof value.id === "number" ? value.id : -1;
}

function sseEvent(block: string): { event: string; data: Record<string, unknown> } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  try {
    const parsed = JSON.parse(data.join("\n")) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? { event, data: parsed as Record<string, unknown> }
      : null;
  } catch {
    return null;
  }
}

export async function observeLiveUpdates(
  response: Response,
  baselineId: number,
): Promise<string[]> {
  if (!response.ok || !response.body) {
    throw new Error(
      `event stream failed (${response.status}): ${errorBody(await readBody(response))}`,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const updates: string[] = [];
  let buffer = "";
  let turnStarted = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error("event stream ended before AgentAPI became stable");
      buffer = `${buffer}${decoder.decode(next.value, { stream: true })}`.replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const event = sseEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        if (
          event?.event === "message_update" &&
          typeof event.data.id === "number" &&
          event.data.id > baselineId &&
          event.data.role === "agent" &&
          typeof event.data.message === "string" &&
          event.data.message !== updates.at(-1)
        ) {
          turnStarted = true;
          updates.push(event.data.message);
        }
        if (event?.event === "status_change" && event.data.status === "running") {
          turnStarted = true;
        }
        if (turnStarted && event?.event === "status_change" && event.data.status === "stable") {
          await reader.cancel("turn stable");
          return updates;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function messageError(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  return typeof value.error === "string" ? value.error : JSON.stringify(value.error);
}

export async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function errorBody(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
