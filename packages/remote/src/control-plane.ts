export interface WorkspaceSummary {
	id: string;
	external_id: string;
	state: string;
	agent_state: string;
	change_cursor: number;
	reason_code: string | null;
	template: { name: string; version: string };
	failure: { reason_code?: string; log_tail?: string } | null;
}

export interface TemplateSummary {
	name: string;
	version: string;
	description?: string;
	status: string;
}

export interface ConversationMessage {
	message_id: string;
	seq: number;
	role: string;
	content: string;
	occurred_at: string;
	metadata: Record<string, string>;
}

export interface ConversationPage {
	items: ConversationMessage[];
	nextCursor: number | null;
}

export const TERMINAL_WORKSPACE_STATES = new Set([
	"succeeded",
	"failed",
	"canceled",
	"expired",
	"preserved",
]);

type FetchLike = typeof fetch;

export class ControlPlaneError extends Error {
	readonly status: number;
	readonly code: string | undefined;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export class ConversationGoneError extends ControlPlaneError {}

export class WorkspaceTerminalError extends Error {
	readonly workspace: WorkspaceSummary;

	constructor(workspace: WorkspaceSummary) {
		const reason = workspace.reason_code ?? workspace.failure?.reason_code ?? "no reason";
		const tail = workspace.failure?.log_tail?.trim();
		super(
			[
				`workspace ${workspace.id} reached ${workspace.state} (${reason})`,
				...(tail ? [`failure log:\n${tail}`] : []),
			].join("\n"),
		);
		this.workspace = workspace;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorCodeOf(body: unknown): string | undefined {
	if (!isRecord(body) || !isRecord(body.error)) return undefined;
	return typeof body.error.code === "string" ? body.error.code : undefined;
}

export interface ControlPlaneConfig {
	baseUrl: string;
	key: string;
}

export class ControlPlaneClient {
	private readonly baseUrl: string;
	private readonly key: string;
	private readonly fetchImpl: FetchLike;

	constructor(config: ControlPlaneConfig, fetchImpl: FetchLike = fetch) {
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.key = config.key;
		this.fetchImpl = fetchImpl;
	}

	private async request(path: string, init: RequestInit = {}): Promise<unknown> {
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.key}`,
				...(init.body ? { "content-type": "application/json" } : {}),
				...(init.headers ?? {}),
			},
		});
		const text = await response.text();
		const body: unknown = text ? JSON.parse(text) : undefined;
		if (!response.ok) {
			const code = errorCodeOf(body);
			const message = `PocketCoder request failed (${response.status}${code ? ` ${code}` : ""})`;
			if (code === "conversation.deleted" || code === "conversation.expired") {
				throw new ConversationGoneError(message, response.status, code);
			}
			throw new ControlPlaneError(message, response.status, code);
		}
		return body;
	}

	async listWorkspaces(
		query: { state?: string; limit?: number } = {},
	): Promise<WorkspaceSummary[]> {
		const params = new URLSearchParams();
		if (query.state) params.set("state", query.state);
		params.set("limit", String(query.limit ?? 50));
		const body = await this.request(`/v1/workspaces?${params}`);
		if (!isRecord(body) || !Array.isArray(body.items)) return [];
		return body.items as WorkspaceSummary[];
	}

	async listTemplates(): Promise<TemplateSummary[]> {
		const body = await this.request("/v1/templates");
		if (!isRecord(body) || !Array.isArray(body.items)) return [];
		return body.items as TemplateSummary[];
	}

	async getWorkspace(id: string): Promise<WorkspaceSummary> {
		return (await this.request(`/v1/workspaces/${encodeURIComponent(id)}`)) as WorkspaceSummary;
	}

	async createWorkspace(input: {
		externalId: string;
		templateName: string;
		templateVersion?: string;
	}): Promise<WorkspaceSummary> {
		return (await this.request("/v1/workspaces", {
			method: "POST",
			headers: { "idempotency-key": input.externalId },
			body: JSON.stringify({
				external_id: input.externalId,
				template: {
					name: input.templateName,
					...(input.templateVersion ? { version: input.templateVersion } : {}),
				},
			}),
		})) as WorkspaceSummary;
	}

	async cancelWorkspace(id: string): Promise<void> {
		await this.request(`/v1/workspaces/${encodeURIComponent(id)}/cancel`, { method: "POST" });
	}

	async readConversationPage(id: string, after: number, limit: number): Promise<ConversationPage> {
		const body = await this.request(
			`/v1/workspaces/${encodeURIComponent(id)}/conversation?after=${after}&limit=${limit}`,
		);
		if (!isRecord(body) || !Array.isArray(body.items)) {
			throw new Error("PocketCoder conversation response was malformed");
		}
		return {
			items: body.items as ConversationMessage[],
			nextCursor: typeof body.next_cursor === "number" ? body.next_cursor : null,
		};
	}

	async readChange(
		id: string,
		after: number,
		wait: number,
		signal?: AbortSignal,
	): Promise<{ cursor: number; workspace: WorkspaceSummary }> {
		const body = await this.request(
			`/v1/workspaces/${encodeURIComponent(id)}/changes?after=${after}&wait=${wait}`,
			{ signal },
		);
		if (!isRecord(body) || typeof body.cursor !== "number" || !isRecord(body.workspace)) {
			throw new Error("PocketCoder changes response was malformed");
		}
		return { cursor: body.cursor, workspace: body.workspace as unknown as WorkspaceSummary };
	}

	async waitForReady(
		initial: WorkspaceSummary,
		timeoutMs: number,
		options: { onTick?: (workspace: WorkspaceSummary) => void; signal?: AbortSignal } = {},
	): Promise<WorkspaceSummary> {
		const deadline = Date.now() + timeoutMs;
		let workspace = initial;
		while (workspace.state !== "ready") {
			if (TERMINAL_WORKSPACE_STATES.has(workspace.state)) {
				throw new WorkspaceTerminalError(workspace);
			}
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				throw new Error(`workspace ${workspace.id} did not become ready within ${timeoutMs}ms`);
			}
			const change = await this.readChange(
				workspace.id,
				workspace.change_cursor ?? 0,
				Math.max(1, Math.min(30, Math.ceil(remainingMs / 1000))),
				options.signal,
			);
			workspace = change.workspace;
			options.onTick?.(workspace);
		}
		return workspace;
	}
}
