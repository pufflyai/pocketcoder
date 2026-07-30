import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export type ChatFlags = Record<string, unknown>;
export type ApiRequest = (path: string, init?: RequestInit) => Promise<Response>;
export type CliFail = (message: string) => never;

export interface WorkspaceChatDeps {
	api: ApiRequest;
	fail: CliFail;
}

function need(flags: ChatFlags, key: string, fail: CliFail): string {
	const value = flags[key];
	if (typeof value !== "string" || value === "") fail(`missing required flag --${key}`);
	return value;
}

function integerFlag(
	flags: ChatFlags,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
	fail: CliFail,
): number {
	const raw = flags[name];
	const value = typeof raw === "number" ? raw : raw === undefined ? fallback : Number(raw);
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		fail(`--${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}

function cursorFile(): string {
	const root =
		process.env.POCKETCODER_STATE_DIR ?? join(homedir(), ".local", "state", "pocketcoder");
	return join(root, "message-cursors.json");
}

function readCursors(path: string): Record<string, string | number> {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, string | number>;
	} catch {
		return {};
	}
}

function writeCursors(path: string, cursors: Record<string, string | number>): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(cursors, null, 2)}\n`, { mode: 0o600 });
}

async function assertWorkspaceAttachable(
	id: string,
	{ api, fail }: WorkspaceChatDeps,
): Promise<void> {
	const response = await api(`/v1/workspaces/${id}`);
	const workspace = (await response.json()) as {
		state?: string;
		persistence?: { latest_checkpoint_id?: string | null };
	};
	if (!response.ok) fail(`workspace lookup failed (${response.status})`);
	if (workspace.state === "ready") return;
	const restore = workspace.persistence?.latest_checkpoint_id
		? ` Restore with: pcd workspaces restore --checkpoint ${workspace.persistence.latest_checkpoint_id} --external-id <new-id>`
		: "";
	fail(`workspace is ${workspace.state ?? "unavailable"}; it is not live.${restore}`);
}

async function sendWorkspaceMessage(
	id: string,
	message: unknown,
	{ api, fail }: WorkspaceChatDeps,
): Promise<void> {
	if (typeof message !== "string") return;
	const response = await api(`/v1/workspaces/${id}/services/agent/message`, {
		method: "POST",
		body: JSON.stringify({ content: message, type: "user" }),
	});
	if (!response.ok) fail(`message failed (${response.status}): ${await response.text()}`);
}

function messageCursor(messages: unknown[], after: string): string | number {
	const last = messages.at(-1) as { id?: unknown } | undefined;
	if (last && (typeof last.id === "number" || typeof last.id === "string")) return last.id;
	return Number(after) + messages.length;
}

export async function attachWorkspace(flags: ChatFlags, deps: WorkspaceChatDeps): Promise<void> {
	const id = need(flags, "id", deps.fail);
	await assertWorkspaceAttachable(id, deps);
	await sendWorkspaceMessage(id, flags.message, deps);
	const file = cursorFile();
	const cursors = readCursors(file);
	const after = typeof flags.after === "string" ? flags.after : String(cursors[id] ?? 0);
	const response = await deps.api(
		`/v1/workspaces/${id}/services/agent/messages?after=${encodeURIComponent(after)}`,
	);
	const body = (await response.json()) as { messages?: unknown[] };
	if (!response.ok) deps.fail(`message polling failed (${response.status})`);
	const messages = body.messages ?? [];
	if (flags.json) console.log(JSON.stringify(messages, null, 2));
	else {
		for (const message of messages) console.log(JSON.stringify(message));
		if (messages.length === 0) console.log("(no new messages)");
	}
	writeCursors(file, { ...cursors, [id]: messageCursor(messages, after) });
}

function chatText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) => chatText(item))
			.filter(Boolean)
			.join("\n");
	}
	if (typeof value !== "object" || value === null) return "";
	const record = value as Record<string, unknown>;
	for (const key of ["text", "content", "message", "delta"]) {
		const text = chatText(record[key]);
		if (text) return text;
	}
	return "";
}

function isAgentMessage(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return [message.role, message.type, message.sender].some(
		(kind) => kind === "assistant" || kind === "agent",
	);
}

function printChatMessage(message: unknown, json: boolean): void {
	if (json) {
		console.log(JSON.stringify(message));
		return;
	}
	const text = chatText(message);
	console.log(`agent> ${text || JSON.stringify(message)}`);
}

interface ChatCursor {
	value: string;
	file: string;
	all: Record<string, string | number>;
}

interface MessageBaseline {
	maxId: number;
	length: number;
}

function chatCursor(id: string, flags: ChatFlags): ChatCursor {
	const file = cursorFile();
	const all = readCursors(file);
	return {
		value: typeof flags.after === "string" ? flags.after : String(all[id] ?? 0),
		file,
		all,
	};
}

function numericMessageId(message: unknown): number | null {
	if (typeof message !== "object" || message === null) return null;
	const id = (message as Record<string, unknown>).id;
	if (typeof id === "number" && Number.isFinite(id)) return id;
	if (typeof id === "string" && id.trim() !== "") {
		const parsed = Number(id);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function messageBaseline(messages: unknown[]): MessageBaseline {
	return {
		maxId: messages.reduce<number>((maximum, message) => {
			const id = numericMessageId(message);
			return id === null ? maximum : Math.max(maximum, id);
		}, -1),
		length: messages.length,
	};
}

function messagesAfter(messages: unknown[], baseline: MessageBaseline): unknown[] {
	const identified = messages.filter((message) => numericMessageId(message) !== null);
	if (identified.length > 0) {
		return identified.filter((message) => (numericMessageId(message) ?? -1) > baseline.maxId);
	}
	return messages.slice(baseline.length);
}

function advanceCursor(id: string, cursor: ChatCursor, messages: unknown[]): void {
	if (messages.length === 0) return;
	const baseline = messageBaseline(messages);
	cursor.value =
		baseline.maxId >= 0
			? String(Math.max(Number(cursor.value) || 0, baseline.maxId))
			: String(Number(cursor.value) + messages.length);
	cursor.all[id] = cursor.value;
	writeCursors(cursor.file, cursor.all);
}

async function readChatMessages(id: string, deps: WorkspaceChatDeps): Promise<unknown[]> {
	const response = await deps.api(`/v1/workspaces/${id}/services/agent/messages`);
	const body = (await response.json()) as { messages?: unknown[] };
	if (!response.ok) {
		deps.fail(`message polling failed (${response.status}): ${JSON.stringify(body)}`);
	}
	return body.messages ?? [];
}

async function readWorkspaceAgentState(id: string, deps: WorkspaceChatDeps): Promise<string> {
	const response = await deps.api(`/v1/workspaces/${id}`);
	const body = (await response.json()) as { state?: unknown; agent_state?: unknown };
	if (!response.ok) {
		deps.fail(`workspace lookup failed (${response.status}): ${JSON.stringify(body)}`);
	}
	if (body.state !== "ready") {
		deps.fail(`workspace is ${String(body.state ?? "unavailable")}; it is not live`);
	}
	if (
		body.agent_state !== "unknown" &&
		body.agent_state !== "running" &&
		body.agent_state !== "stable"
	) {
		deps.fail(`workspace returned unknown agent state: ${JSON.stringify(body.agent_state)}`);
	}
	return typeof body.agent_state === "string" ? body.agent_state : "unknown";
}

async function pollTurnResponse(
	id: string,
	baseline: MessageBaseline,
	cursor: ChatCursor,
	options: {
		json: boolean;
		pollIntervalMs: number;
		timeoutSeconds: number;
		interrupted: () => boolean;
	},
	deps: WorkspaceChatDeps,
): Promise<void> {
	const deadline = Date.now() + options.timeoutSeconds * 1000;
	while (!options.interrupted()) {
		const [status, messages] = await Promise.all([
			readWorkspaceAgentState(id, deps),
			readChatMessages(id, deps),
		]);
		const replies = messagesAfter(messages, baseline).filter(isAgentMessage);
		advanceCursor(id, cursor, messages);
		const reply = replies.at(-1);
		if (status === "stable" && reply && chatText(reply).trim()) {
			printChatMessage(reply, options.json);
			return;
		}
		if (Date.now() >= deadline) {
			deps.fail(`agent did not respond within ${options.timeoutSeconds} seconds`);
		}
		await Bun.sleep(options.pollIntervalMs);
	}
}

async function followChatMessages(
	id: string,
	cursor: ChatCursor,
	options: {
		json: boolean;
		pollIntervalMs: number;
		interrupted: () => boolean;
	},
	deps: WorkspaceChatDeps,
): Promise<void> {
	let baseline: MessageBaseline = {
		maxId: Number(cursor.value) || 0,
		length: 0,
	};
	while (!options.interrupted()) {
		const messages = await readChatMessages(id, deps);
		for (const message of messagesAfter(messages, baseline)) {
			if (isAgentMessage(message)) printChatMessage(message, options.json);
		}
		baseline = messageBaseline(messages);
		advanceCursor(id, cursor, messages);
		await Bun.sleep(options.pollIntervalMs);
	}
}

async function cancelWorkspace(id: string, api: ApiRequest): Promise<void> {
	await api(`/v1/workspaces/${id}/cancel`, { method: "POST" }).catch(() => {});
}

export async function chatWorkspace(flags: ChatFlags, deps: WorkspaceChatDeps): Promise<void> {
	const id = need(flags, "id", deps.fail);
	await assertWorkspaceAttachable(id, deps);
	const pollIntervalMs = integerFlag(flags, "poll-interval-ms", 500, 100, 10_000, deps.fail);
	const responseTimeoutSeconds = integerFlag(
		flags,
		"response-timeout-seconds",
		600,
		1,
		3600,
		deps.fail,
	);
	const cursor = chatCursor(id, flags);
	let interrupted = false;
	const interrupt = () => {
		interrupted = true;
	};
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	let readline: ReturnType<typeof createInterface> | null = null;
	const sendTurn = async (message: string) => {
		if (!message.trim()) return;
		const before = await readChatMessages(id, deps);
		const baseline = messageBaseline(before);
		advanceCursor(id, cursor, before);
		await sendWorkspaceMessage(id, message, deps);
		await pollTurnResponse(
			id,
			baseline,
			cursor,
			{
				json: flags.json === true,
				pollIntervalMs,
				timeoutSeconds: responseTimeoutSeconds,
				interrupted: () => interrupted,
			},
			deps,
		);
	};

	try {
		if (typeof flags.message === "string") {
			await sendTurn(flags.message);
			if (flags.follow === true && !interrupted) {
				await followChatMessages(
					id,
					cursor,
					{
						json: flags.json === true,
						pollIntervalMs,
						interrupted: () => interrupted,
					},
					deps,
				);
			}
			return;
		}

		readline = createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: process.stdin.isTTY,
		});
		readline.on("SIGINT", () => {
			interrupted = true;
			readline?.close();
		});
		if (process.stdin.isTTY) process.stdout.write("pocketcoder> ");
		for await (const line of readline) {
			if (interrupted) break;
			await sendTurn(line);
			if (process.stdin.isTTY && !interrupted) process.stdout.write("pocketcoder> ");
		}
		if (flags.follow === true && !interrupted) {
			await followChatMessages(
				id,
				cursor,
				{
					json: flags.json === true,
					pollIntervalMs,
					interrupted: () => interrupted,
				},
				deps,
			);
		}
	} finally {
		readline?.close();
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		if (flags["cancel-on-exit"] === true) await cancelWorkspace(id, deps.api);
		if (interrupted) process.exitCode = 130;
	}
}
