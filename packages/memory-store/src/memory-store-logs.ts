import type { LogRow, Store } from "@pstdio/pocketcoder-runtime-contracts";

import { MAX_LOG_BYTES } from "./memory-store-base";
import { MemoryOperationStore } from "./memory-store-operations";

export class MemoryLogStore extends MemoryOperationStore {
	async appendLogs(
		workspaceId: string,
		entries: Array<{ stream: LogRow["stream"]; occurredAt: Date; content: Uint8Array }>,
	): Promise<void> {
		const list = this.logs.get(workspaceId) ?? [];
		let bytes = this.logBytes.get(workspaceId) ?? 0;
		let seq = list.length > 0 ? (list[list.length - 1]?.seq ?? 0) : 0;
		for (const entry of entries) {
			if (bytes + entry.content.length > MAX_LOG_BYTES) {
				break;
			}
			seq += 1;
			bytes += entry.content.length;
			list.push({
				workspaceId,
				seq,
				stream: entry.stream,
				occurredAt: entry.occurredAt,
				content: entry.content,
			});
		}
		this.logs.set(workspaceId, list);
		this.logBytes.set(workspaceId, bytes);
	}

	async readLogs(workspaceId: string, afterSeq: number, limit: number): Promise<LogRow[]> {
		return (this.logs.get(workspaceId) ?? [])
			.filter((l) => l.seq > afterSeq)
			.slice(0, limit)
			.map((l) => ({ ...l }));
	}

	async readLogTail(
		workspaceId: string,
		maxBytes: number,
	): Promise<{ content: Uint8Array; truncated: boolean; lastSeq: number | null }> {
		const rows = this.logs.get(workspaceId) ?? [];
		const lastSeq = rows.at(-1)?.seq ?? null;
		const totalBytes = rows.reduce((sum, row) => sum + row.content.byteLength, 0);
		const combined = Buffer.concat(rows.map((row) => Buffer.from(row.content)));
		const content = combined.byteLength > maxBytes ? combined.subarray(-maxBytes) : combined;
		return {
			content: Uint8Array.from(content),
			truncated: totalBytes > maxBytes,
			lastSeq,
		};
	}

	async appendNetworkEvents(
		workspaceId: string,
		sourceSessionId: string,
		events: Parameters<Store["appendNetworkEvents"]>[2],
	): Promise<void> {
		const rows = this.networkEvents.get(workspaceId) ?? [];
		const seen = new Set(rows.map((row) => `${row.sourceSessionId}:${row.source_seq}`));
		const workspace = this.workspaces.get(workspaceId);
		if (!workspace) throw new Error("workspace.not_found");
		for (const event of events) {
			const key = `${sourceSessionId}:${event.source_seq}`;
			if (seen.has(key)) continue;
			workspace.networkEventSeq += 1;
			rows.push({ ...event, workspaceId, sourceSessionId, seq: workspace.networkEventSeq });
			seen.add(key);
		}
		this.networkEvents.set(workspaceId, rows);
	}

	async readNetworkEvents(workspaceId: string, afterSeq: number, limit: number) {
		return (this.networkEvents.get(workspaceId) ?? [])
			.filter((row) => row.seq > afterSeq)
			.slice(0, limit)
			.map((row) => ({ ...row }));
	}

	// --- Durable conversation history ---
}
