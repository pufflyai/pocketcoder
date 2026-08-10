import {
	CheckpointPageSchema,
	CheckpointResourceSchema,
	type CheckpointState,
	OperationResourceSchema,
	type RestoreRequest,
	RestoreResponseSchema,
} from "@pstdio/pocketcoder-contracts";
import { type CursorListQuery, page, queryString } from "./common";
import type { PocketCoderTransport, RequestOptions } from "./transport";

export class CheckpointsApi {
	constructor(private readonly transport: PocketCoderTransport) {}

	async list(
		workspaceId: string,
		query: CursorListQuery & { state?: CheckpointState } = {},
		options: RequestOptions = {},
	) {
		const body = await this.transport.request(
			`/v1/workspaces/${encodeURIComponent(workspaceId)}/checkpoints?${queryString({ state: query.state, cursor: query.cursor, limit: query.limit ?? 50 })}`,
			CheckpointPageSchema,
			options,
		);
		return page(body);
	}

	get(id: string, options: RequestOptions = {}) {
		return this.transport.request(
			`/v1/checkpoints/${encodeURIComponent(id)}`,
			CheckpointResourceSchema,
			options,
		);
	}

	verify(id: string, key: string, options: RequestOptions = {}) {
		return this.operationRequest(
			`/v1/checkpoints/${encodeURIComponent(id)}/verify`,
			"POST",
			key,
			options,
		);
	}

	delete(id: string, key: string, options: RequestOptions = {}) {
		return this.operationRequest(
			`/v1/checkpoints/${encodeURIComponent(id)}`,
			"DELETE",
			key,
			options,
		);
	}

	restore(id: string, input: RestoreRequest, key: string, options: RequestOptions = {}) {
		return this.transport.request(
			`/v1/checkpoints/${encodeURIComponent(id)}/restore`,
			RestoreResponseSchema,
			{
				method: "POST",
				signal: options.signal,
				headers: { "Idempotency-Key": key },
				body: JSON.stringify(input),
			},
		);
	}

	private operationRequest(path: string, method: string, key: string, options: RequestOptions) {
		return this.transport.request(path, OperationResourceSchema, {
			method,
			signal: options.signal,
			headers: { "Idempotency-Key": key },
		});
	}
}

export class OperationsApi {
	constructor(private readonly transport: PocketCoderTransport) {}

	get(id: string, options: RequestOptions = {}) {
		return this.transport.request(
			`/v1/operations/${encodeURIComponent(id)}`,
			OperationResourceSchema,
			options,
		);
	}
}
