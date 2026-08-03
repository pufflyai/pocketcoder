import { describe, expect, test } from "bun:test";
import { ControlPlaneClient, type ConversationMessage } from "./control-plane";
import { replayHistory } from "./history";
import {
	type ConversationEntryData,
	formatConversationMessage,
	formatHistoryNotice,
	HISTORY_ENTRY_TYPE,
	NOTICE_ENTRY_TYPE,
	type ThemeLike,
} from "./renderers";

function message(seq: number, overrides: Partial<ConversationMessage> = {}): ConversationMessage {
	return {
		message_id: `m${seq}`,
		seq,
		role: seq % 2 === 1 ? "user" : "assistant",
		content: `message ${seq}`,
		occurred_at: "2026-01-01T00:00:00Z",
		metadata: {},
		...overrides,
	};
}

function conversationClient(messages: ConversationMessage[], status = 200): ControlPlaneClient {
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const request =
			input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
		const url = new URL(request.url);
		if (!url.pathname.endsWith("/conversation")) return new Response("not found", { status: 404 });
		if (status !== 200) {
			return Response.json(
				{ error: { code: "conversation.expired", message: "gone", request_id: "r1" } },
				{ status },
			);
		}
		const after = Number(url.searchParams.get("after"));
		const limit = Number(url.searchParams.get("limit"));
		const items = messages.filter((item) => item.seq > after).slice(0, limit);
		const last = items.at(-1);
		return Response.json({
			items,
			next_cursor: items.length === limit && last ? last.seq : null,
			retention: { status: "retained", expires_at: null },
		});
	}) as typeof fetch;
	return new ControlPlaneClient(
		{ baseUrl: "http://pocketcoder.test", key: "pkt_example" },
		fetchImpl,
	);
}

interface RecordedEntry {
	customType: string;
	data: unknown;
}

function dataOf(entry: RecordedEntry | undefined): ConversationEntryData {
	return (entry?.data ?? {}) as ConversationEntryData;
}

function sink(): { entries: RecordedEntry[]; appendEntry<T>(customType: string, data?: T): void } {
	const entries: RecordedEntry[] = [];
	return {
		entries,
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
	};
}

describe("history replay", () => {
	test("replays a multi-page transcript in order", async () => {
		const messages = Array.from({ length: 5 }, (_, index) => message(index + 1));
		const pi = sink();

		const outcome = await replayHistory(pi, conversationClient(messages), "ws", { pageLimit: 2 });

		expect(outcome).toEqual({ replayed: 5, total: 5, truncated: false, gone: false });
		expect(pi.entries).toHaveLength(5);
		expect(pi.entries.every((entry) => entry.customType === HISTORY_ENTRY_TYPE)).toBe(true);
		expect(dataOf(pi.entries[0]).seq).toBe(1);
		expect(dataOf(pi.entries[4]).seq).toBe(5);
	});

	test("tails long transcripts and prepends a notice", async () => {
		const messages = Array.from({ length: 6 }, (_, index) => message(index + 1));
		const pi = sink();

		const outcome = await replayHistory(pi, conversationClient(messages), "ws", {
			pageLimit: 2,
			maxMessages: 2,
		});

		expect(outcome.replayed).toBe(2);
		expect(outcome.total).toBe(6);
		expect(outcome.truncated).toBe(true);
		expect(pi.entries[0]?.customType).toBe(NOTICE_ENTRY_TYPE);
		expect(pi.entries[0]?.data).toEqual({ text: "showing last 2 of 6 messages" });
		expect(dataOf(pi.entries.at(-1)).seq).toBe(6);
	});

	test("stops at the page cap with a warning notice", async () => {
		const messages = Array.from({ length: 6 }, (_, index) => message(index + 1));
		const pi = sink();

		const outcome = await replayHistory(pi, conversationClient(messages), "ws", {
			pageLimit: 2,
			maxPages: 2,
		});

		expect(outcome.replayed).toBe(4);
		expect(outcome.truncated).toBe(true);
		expect(pi.entries[0]?.data).toEqual({
			text: "history partially replayed (stopped after 2 pages)",
		});
	});

	test("renders a warning entry when the conversation is gone", async () => {
		const pi = sink();

		const outcome = await replayHistory(pi, conversationClient([], 410), "ws");

		expect(outcome).toEqual({ replayed: 0, total: 0, truncated: false, gone: true });
		expect(pi.entries).toEqual([
			{
				customType: NOTICE_ENTRY_TYPE,
				data: { text: "conversation history has expired", level: "warning" },
			},
		]);
	});

	test("forwards a kind from message metadata for future typed rendering", async () => {
		const pi = sink();
		const messages = [message(1, { metadata: { kind: "status" } })];

		await replayHistory(pi, conversationClient(messages), "ws");

		expect(dataOf(pi.entries[0]).kind).toBe("status");
	});
});

describe("conversation formatting", () => {
	const theme: ThemeLike = {
		fg: (color, text) => `[${color}]${text}[/]`,
		bold: (text) => `*${text}*`,
	};

	test("styles roles distinctly and keeps assistant text plain", () => {
		const user = formatConversationMessage(
			{ role: "user", content: "hi", seq: 1, occurred_at: "2026-01-01T00:00:00Z" },
			theme,
		);
		expect(user).toContain("[muted]user · 2026-01-01 00:00:00[/]");
		expect(user).toContain("[userMessageText]hi[/]");

		const assistant = formatConversationMessage(
			{ role: "assistant", content: "hello", seq: 2, occurred_at: "2026-01-01T00:00:01Z" },
			theme,
		);
		expect(assistant.endsWith("\nhello")).toBe(true);

		const tool = formatConversationMessage(
			{ role: "tool", content: "ran", seq: 3, occurred_at: "2026-01-01T00:00:02Z" },
			theme,
		);
		expect(tool).toContain("[dim]ran[/]");
	});

	test("renders notices with their level", () => {
		expect(formatHistoryNotice({ text: "expired", level: "warning" }, theme)).toBe(
			"[warning]expired[/]",
		);
		expect(formatHistoryNotice({ text: "info" }, theme)).toBe("[muted]info[/]");
	});
});
