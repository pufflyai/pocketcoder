export interface AgentApiMessage {
  id: number;
  content: string;
  role: string;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("remote request aborted"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseMessages(value: unknown): AgentApiMessage[] {
  const items = isRecord(value) && Array.isArray(value.messages) ? value.messages : [];
  return items.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "number" ||
      typeof item.content !== "string" ||
      typeof item.role !== "string"
    ) {
      return [];
    }
    return [{ id: item.id, content: item.content, role: item.role }];
  });
}

export function isAgentMessage(message: AgentApiMessage): boolean {
  return message.role === "agent" || message.role === "assistant";
}

export function changesUrlFor(serviceUrl: string): string | undefined {
  const url = new URL(serviceUrl);
  const match = url.pathname.match(/^(.*\/v1\/workspaces\/[^/]+)\/(?:agent|services\/agent)$/);
  if (!match) return undefined;
  url.pathname = `${match[1]}/changes`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
