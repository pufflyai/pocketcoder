import { randomUUID } from "node:crypto";

const TERMINAL_STATES = new Set(["succeeded", "failed", "canceled", "expired"]);

export interface HarnessE2EConfig {
	baseUrl: string;
	key: string;
	template: string;
	templateVersion?: string;
	prompt: string;
	expectedResponse?: string;
	readyTimeoutMs?: number;
	messageTimeoutMs?: number;
	pollIntervalMs?: number;
}

export interface HarnessE2EReport {
	workspaceId: string;
	template: string;
	readyInMs: number;
	responseInMs: number;
	terminalState: string;
	responseText: string;
}

interface WorkspaceResource {
	id: string;
	state: string;
	reason_code?: string | null;
}

type FetchLike = typeof fetch;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageList(value: unknown): unknown[] {
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

function responseText(messages: unknown[], baselineLength: number): string {
	return messages
		.slice(baselineLength)
		.filter(isAssistantMessage)
		.map((message) => textContent(message))
		.filter(Boolean)
		.join("\n");
}

function messageError(value: unknown): string | null {
	if (typeof value !== "object" || value === null || !("error" in value)) return null;
	return typeof value.error === "string" ? value.error : JSON.stringify(value.error);
}

async function readBody(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function errorBody(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

async function waitFor<T>(
	read: () => Promise<T | null>,
	timeoutMs: number,
	pollIntervalMs: number,
	description: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== null) return value;
		await delay(pollIntervalMs);
	}
	throw new Error(`timed out waiting for ${description} after ${timeoutMs}ms`);
}

export async function runHarnessE2E(
	config: HarnessE2EConfig,
	fetchImpl: FetchLike = fetch,
): Promise<HarnessE2EReport> {
	const baseUrl = config.baseUrl.replace(/\/$/, "");
	const readyTimeoutMs = config.readyTimeoutMs ?? 120_000;
	const messageTimeoutMs = config.messageTimeoutMs ?? 300_000;
	const pollIntervalMs = config.pollIntervalMs ?? 500;
	const externalId = `example-${Date.now()}-${randomUUID()}`;
	const headers = {
		authorization: `Bearer ${config.key}`,
		"content-type": "application/json",
	};
	const request = async (path: string, init: RequestInit = {}): Promise<Response> =>
		await fetchImpl(`${baseUrl}${path}`, {
			...init,
			headers: { ...headers, ...(init.headers ?? {}) },
		});

	let workspaceId: string | null = null;
	let completed = false;
	try {
		const createResponse = await request("/v1/workspaces", {
			method: "POST",
			headers: { "idempotency-key": externalId },
			body: JSON.stringify({
				external_id: externalId,
				template: {
					name: config.template,
					...(config.templateVersion ? { version: config.templateVersion } : {}),
				},
				launch_input: { example: "harness-e2e" },
				metadata: { source: "examples/e2e" },
			}),
		});
		const created = (await readBody(createResponse)) as WorkspaceResource;
		if (!createResponse.ok || typeof created?.id !== "string") {
			throw new Error(`workspace create failed (${createResponse.status}): ${errorBody(created)}`);
		}
		workspaceId = created.id;

		const readyStartedAt = Date.now();
		await waitFor(
			async () => {
				const response = await request(`/v1/workspaces/${workspaceId}`);
				const workspace = (await readBody(response)) as WorkspaceResource;
				if (!response.ok) {
					throw new Error(`workspace read failed (${response.status}): ${errorBody(workspace)}`);
				}
				if (workspace.state === "ready") return workspace;
				if (TERMINAL_STATES.has(workspace.state)) {
					throw new Error(
						`workspace reached ${workspace.state} (${workspace.reason_code ?? "no reason"}) before ready`,
					);
				}
				return null;
			},
			readyTimeoutMs,
			pollIntervalMs,
			"workspace readiness",
		);
		const readyInMs = Date.now() - readyStartedAt;

		const statusResponse = await request(`/v1/workspaces/${workspaceId}/services/agent/status`);
		if (!statusResponse.ok) {
			throw new Error(
				`status relay failed (${statusResponse.status}): ${errorBody(await readBody(statusResponse))}`,
			);
		}

		const beforeResponse = await request(`/v1/workspaces/${workspaceId}/services/agent/messages`);
		const before = beforeResponse.ok ? messageList(await readBody(beforeResponse)) : [];

		const messageStartedAt = Date.now();
		const sendResponse = await request(`/v1/workspaces/${workspaceId}/services/agent/message`, {
			method: "POST",
			body: JSON.stringify({ content: config.prompt, type: "user" }),
		});
		if (!sendResponse.ok) {
			throw new Error(
				`message relay failed (${sendResponse.status}): ${errorBody(await readBody(sendResponse))}`,
			);
		}

		const observedText = await waitFor(
			async () => {
				const response = await request(`/v1/workspaces/${workspaceId}/services/agent/messages`);
				if (!response.ok) return null;
				const messages = messageList(await readBody(response));
				const harnessError = messages.slice(before.length).map(messageError).find(Boolean);
				if (harnessError) throw new Error(`harness reported an error: ${harnessError}`);
				const text = responseText(messages, before.length);
				if (config.expectedResponse) {
					return text.includes(config.expectedResponse) ? text : null;
				}
				return text || null;
			},
			messageTimeoutMs,
			pollIntervalMs,
			"harness response",
		);
		const responseInMs = Date.now() - messageStartedAt;

		const cancelResponse = await request(`/v1/workspaces/${workspaceId}/cancel`, {
			method: "POST",
		});
		if (!cancelResponse.ok) {
			throw new Error(
				`workspace cancel failed (${cancelResponse.status}): ${errorBody(await readBody(cancelResponse))}`,
			);
		}
		const terminal = await waitFor(
			async () => {
				const response = await request(`/v1/workspaces/${workspaceId}`);
				if (!response.ok) return null;
				const workspace = (await readBody(response)) as WorkspaceResource;
				return TERMINAL_STATES.has(workspace.state) ? workspace : null;
			},
			30_000,
			pollIntervalMs,
			"workspace cancellation",
		);
		if (terminal.state !== "canceled") {
			throw new Error(`expected canceled workspace, got ${terminal.state}`);
		}
		completed = true;
		return {
			workspaceId,
			template: config.template,
			readyInMs,
			responseInMs,
			terminalState: terminal.state,
			responseText: observedText,
		};
	} finally {
		if (workspaceId && !completed) {
			await request(`/v1/workspaces/${workspaceId}/cancel`, { method: "POST" }).catch(() => {});
		}
	}
}
