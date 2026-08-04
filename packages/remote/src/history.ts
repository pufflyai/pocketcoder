import type { ControlPlaneClient } from "./control-plane";
import { ConversationGoneError } from "./control-plane";
import {
	type ConversationEntryData,
	HISTORY_ENTRY_TYPE,
	type HistoryNoticeData,
	NOTICE_ENTRY_TYPE,
} from "./renderers";

export interface ReplayOptions {
	pageLimit?: number;
	maxMessages?: number;
	maxPages?: number;
}

export interface ReplayOutcome {
	replayed: number;
	total: number;
	truncated: boolean;
	gone: boolean;
}

export interface EntrySink {
	appendEntry<T = unknown>(customType: string, data?: T): void;
}

/**
 * Replays the workspace's durable conversation into the local session as
 * custom entries. The server transcript is the source of truth: this runs on
 * every attach, and entries never participate in LLM context.
 */
interface TranscriptTail {
	tail: ConversationEntryData[];
	total: number;
	pages: number;
	exhaustedPages: boolean;
}

async function collectTranscriptTail(
	controlPlane: ControlPlaneClient,
	workspaceId: string,
	options: Required<ReplayOptions>,
): Promise<TranscriptTail> {
	const tail: ConversationEntryData[] = [];
	let total = 0;
	let pages = 0;
	let cursor: string | undefined;
	while (pages < options.maxPages) {
		const page = await controlPlane.conversations.list(workspaceId, {
			cursor,
			limit: options.pageLimit,
		});
		pages += 1;
		for (const message of page.items) {
			total += 1;
			tail.push({
				role: message.role,
				content: message.content,
				seq: message.seq,
				occurred_at: message.occurred_at,
				kind: message.metadata?.kind,
				metadata: message.metadata,
			});
			if (tail.length > options.maxMessages) tail.shift();
		}
		if (page.nextCursor === null) return { tail, total, pages, exhaustedPages: false };
		cursor = page.nextCursor;
	}
	return { tail, total, pages, exhaustedPages: true };
}

export async function replayHistory(
	pi: EntrySink,
	controlPlane: ControlPlaneClient,
	workspaceId: string,
	options: ReplayOptions = {},
): Promise<ReplayOutcome> {
	let transcript: TranscriptTail;
	try {
		transcript = await collectTranscriptTail(controlPlane, workspaceId, {
			pageLimit: options.pageLimit ?? 200,
			maxMessages: options.maxMessages ?? 1000,
			maxPages: options.maxPages ?? 50,
		});
	} catch (error) {
		if (error instanceof ConversationGoneError) {
			pi.appendEntry<HistoryNoticeData>(NOTICE_ENTRY_TYPE, {
				text:
					error.code === "conversation.deleted"
						? "conversation history was deleted"
						: "conversation history has expired",
				level: "warning",
			});
			return { replayed: 0, total: 0, truncated: false, gone: true };
		}
		throw error;
	}

	const { tail, total, pages, exhaustedPages } = transcript;
	const truncated = total > tail.length || exhaustedPages;
	if (truncated) {
		pi.appendEntry<HistoryNoticeData>(NOTICE_ENTRY_TYPE, {
			text: exhaustedPages
				? `history partially replayed (stopped after ${pages} pages)`
				: `showing last ${tail.length} of ${total} messages`,
		});
	}
	for (const message of tail) {
		pi.appendEntry<ConversationEntryData>(HISTORY_ENTRY_TYPE, message);
	}
	return { replayed: tail.length, total, truncated, gone: false };
}
