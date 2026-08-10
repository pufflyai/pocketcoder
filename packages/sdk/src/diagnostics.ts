import {
	type LogChunk,
	LogPageSchema,
	type NetworkEvent,
	NetworkEventPageSchema,
	OutputPageSchema,
	type OutputResource,
} from "@pstdio/pocketcoder-contracts";
import type { z } from "zod";
import { type CursorListQuery, type Page, page, queryString } from "./common";
import type { PocketCoderTransport, RequestOptions } from "./transport";

class WorkspaceCursorApi<T> {
	constructor(
		private readonly transport: PocketCoderTransport,
		private readonly resource: string,
		private readonly schema: z.ZodType<{ items: T[]; next_cursor: string | null }>,
	) {}

	async list(
		workspaceId: string,
		query: CursorListQuery = {},
		options: RequestOptions = {},
	): Promise<Page<T>> {
		const body = await this.transport.request(
			`/v1/workspaces/${encodeURIComponent(workspaceId)}/${this.resource}?${queryString({ cursor: query.cursor, limit: query.limit ?? 100 })}`,
			this.schema,
			options,
		);
		return page(body);
	}
}

export class LogsApi extends WorkspaceCursorApi<LogChunk> {
	constructor(transport: PocketCoderTransport) {
		super(transport, "logs", LogPageSchema);
	}
}

export class NetworkEventsApi extends WorkspaceCursorApi<NetworkEvent> {
	constructor(transport: PocketCoderTransport) {
		super(transport, "network-events", NetworkEventPageSchema);
	}
}

export class OutputsApi extends WorkspaceCursorApi<OutputResource> {
	constructor(transport: PocketCoderTransport) {
		super(transport, "outputs", OutputPageSchema);
	}
}
