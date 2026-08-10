import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { splitAttachmentManifest } from "@pstdio/pocketcoder-sdk";

export const HISTORY_ENTRY_TYPE = "pocketcoder-conversation";
export const NOTICE_ENTRY_TYPE = "pocketcoder-history-notice";

export interface ConversationEntryData {
	role: string;
	content: string;
	seq: number;
	occurred_at: string;
	/** Reserved for future typed payloads (tool_use, permission_request, ...). */
	kind?: string;
	metadata?: Record<string, string>;
}

export interface HistoryNoticeData {
	text: string;
	level?: "info" | "warning";
}

/** The slice of Pi's Theme the formatters use; Theme satisfies it structurally. */
export interface ThemeLike {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
}

function roleHeader(data: ConversationEntryData, theme: ThemeLike): string {
	const time = data.occurred_at.replace("T", " ").replace(/\.\d+Z?$|Z$/, "");
	return theme.fg("muted", `${data.role} · ${time}`);
}

// User messages may end in the generated attachment manifest; history shows
// the attachment names instead of the raw markup and managed paths.
function userBody(content: string, theme: ThemeLike): string {
	const { text, attachments } = splitAttachmentManifest(content);
	const body = theme.fg("userMessageText", text);
	if (!attachments) return body;
	const list = attachments
		.map((attachment) => theme.fg("muted", `⌁ ${attachment.name} (${attachment.size_bytes} bytes)`))
		.join("\n");
	return `${body}\n${list}`;
}

export function formatConversationMessage(data: ConversationEntryData, theme: ThemeLike): string {
	switch (data.kind ?? "text") {
		// Future typed kinds (tool_use, permission_request, ...) become new cases;
		// unknown kinds deliberately fall through to the text rendering.
		default: {
			const header = roleHeader(data, theme);
			const body =
				data.role === "user"
					? userBody(data.content, theme)
					: data.role === "assistant"
						? data.content
						: theme.fg("dim", data.content);
			return `${header}\n${body}`;
		}
	}
}

export function formatHistoryNotice(data: HistoryNoticeData, theme: ThemeLike): string {
	return theme.fg(data.level === "warning" ? "warning" : "muted", data.text);
}

export function registerConversationRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<ConversationEntryData>(HISTORY_ENTRY_TYPE, (entry, _options, theme) => {
		if (!entry.data) return undefined;
		return new Text(formatConversationMessage(entry.data, theme), 1, 0);
	});
	pi.registerEntryRenderer<HistoryNoticeData>(NOTICE_ENTRY_TYPE, (entry, _options, theme) => {
		if (!entry.data) return undefined;
		return new Text(formatHistoryNotice(entry.data, theme), 1, 0);
	});
}
