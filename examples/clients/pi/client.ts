export interface AgentApiMessage {
	id: number;
	content: string;
	role: string;
}

export interface RemoteAgentClientConfig {
	serviceUrl: string;
	key: string;
	pollIntervalMs?: number;
	timeoutMs?: number;
}

interface AgentApiStatus {
	status?: string;
}

interface AgentApiMessages {
	messages?: unknown;
}

type FetchLike = typeof fetch;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
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

function parseMessages(value: unknown): AgentApiMessage[] {
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

function isAgentMessage(message: AgentApiMessage): boolean {
	return message.role === "agent" || message.role === "assistant";
}

async function responseError(response: Response): Promise<string> {
	const body = (await response.text()).trim();
	return body ? `${response.status} ${body.slice(0, 1000)}` : String(response.status);
}

export class RemoteAgentClient {
	readonly serviceUrl: string;
	readonly key: string;
	readonly pollIntervalMs: number;
	readonly timeoutMs: number;
	readonly fetchImpl: FetchLike;

	constructor(config: RemoteAgentClientConfig, fetchImpl: FetchLike = fetch) {
		this.serviceUrl = config.serviceUrl.replace(/\/$/, "");
		this.key = config.key;
		this.pollIntervalMs = config.pollIntervalMs ?? 250;
		this.timeoutMs = config.timeoutMs ?? 600_000;
		this.fetchImpl = fetchImpl;
	}

	private async request(path: string, init: RequestInit = {}): Promise<Response> {
		return await this.fetchImpl(`${this.serviceUrl}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.key}`,
				...(init.body ? { "content-type": "application/json" } : {}),
				...(init.headers ?? {}),
			},
		});
	}

	private async messages(signal?: AbortSignal): Promise<AgentApiMessage[]> {
		const response = await this.request("/messages", { signal });
		if (!response.ok) {
			throw new Error(`AgentAPI messages request failed: ${await responseError(response)}`);
		}
		return parseMessages((await response.json()) as AgentApiMessages);
	}

	private async status(signal?: AbortSignal): Promise<string> {
		const response = await this.request("/status", { signal });
		if (!response.ok) {
			throw new Error(`AgentAPI status request failed: ${await responseError(response)}`);
		}
		const body = (await response.json()) as AgentApiStatus;
		if (body.status !== "running" && body.status !== "stable") {
			throw new Error(`AgentAPI returned an unknown status: ${JSON.stringify(body.status)}`);
		}
		return body.status;
	}

	async send(prompt: string, signal?: AbortSignal): Promise<string> {
		const before = await this.messages(signal);
		const baselineId = before.reduce((maximum, message) => Math.max(maximum, message.id), -1);
		const response = await this.request("/message", {
			method: "POST",
			body: JSON.stringify({ content: prompt, type: "user" }),
			signal,
		});
		if (!response.ok) {
			throw new Error(`AgentAPI message request failed: ${await responseError(response)}`);
		}

		const deadline = Date.now() + this.timeoutMs;
		while (Date.now() < deadline) {
			const [status, messages] = await Promise.all([this.status(signal), this.messages(signal)]);
			const reply = messages
				.filter((message) => message.id > baselineId && isAgentMessage(message))
				.at(-1);
			if (status === "stable" && reply?.content.trim()) return reply.content;
			await delay(this.pollIntervalMs, signal);
		}
		throw new Error(`remote agent did not finish within ${this.timeoutMs}ms`);
	}
}

export function serviceUrlFromEnvironment(env: NodeJS.ProcessEnv = process.env): {
	serviceUrl: string;
	key: string;
} {
	const directUrl = env.POCKETCODER_AGENTAPI_URL;
	const key = env.POCKETCODER_KEY;
	if (!key) throw new Error("POCKETCODER_KEY is required");
	if (directUrl) return { serviceUrl: directUrl, key };

	const baseUrl = (env.POCKETCODER_URL ?? "http://127.0.0.1:7080").replace(/\/$/, "");
	const workspaceId = env.POCKETCODER_WORKSPACE_ID;
	if (!workspaceId) {
		throw new Error("POCKETCODER_WORKSPACE_ID or POCKETCODER_AGENTAPI_URL is required");
	}
	return {
		serviceUrl: `${baseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/services/agent`,
		key,
	};
}
