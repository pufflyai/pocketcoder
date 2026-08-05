interface MessageUpdate {
	event: "message_update";
	data: {
		id: number;
		message: string;
		role: string;
		time?: string;
	};
}

interface StatusChange {
	event: "status_change";
	data: {
		agent_type?: string;
		status: "running" | "stable";
	};
}

interface AgentError {
	event: "agent_error";
	data: {
		level?: string;
		message: string;
		time?: string;
	};
}

export type AgentApiEvent = MessageUpdate | StatusChange | AgentError;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function eventPayload(block: string): { event: string; parsed: Record<string, unknown> } | null {
	let event = "message";
	const data: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) continue;
		const separator = line.indexOf(":");
		const field = separator === -1 ? line : line.slice(0, separator);
		const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
		if (field === "event") event = value;
		if (field === "data") data.push(value);
	}
	if (data.length === 0) return null;
	try {
		const parsed = JSON.parse(data.join("\n")) as unknown;
		return isRecord(parsed) ? { event, parsed } : null;
	} catch {
		return null;
	}
}

function parseEvent(block: string): AgentApiEvent | null {
	const payload = eventPayload(block);
	if (!payload) return null;
	const { event, parsed } = payload;
	if (
		event === "message_update" &&
		typeof parsed.id === "number" &&
		typeof parsed.message === "string" &&
		typeof parsed.role === "string"
	) {
		return { event, data: parsed as MessageUpdate["data"] };
	}
	if (event === "status_change" && (parsed.status === "running" || parsed.status === "stable")) {
		return { event, data: parsed as StatusChange["data"] };
	}
	if (event === "agent_error" && typeof parsed.message === "string") {
		return { event, data: parsed as AgentError["data"] };
	}
	return null;
}

export async function* readAgentApiEvents(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): AsyncGenerator<AgentApiEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const abort = () => {
		void reader.cancel(signal.reason).catch(() => {});
	};
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	try {
		while (!signal.aborted) {
			const next = await reader.read();
			if (next.done) break;
			buffer = `${buffer}${decoder.decode(next.value, { stream: true })}`.replaceAll("\r\n", "\n");
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const event = parseEvent(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 2);
				if (event) yield event;
				boundary = buffer.indexOf("\n\n");
			}
		}
	} finally {
		signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}
