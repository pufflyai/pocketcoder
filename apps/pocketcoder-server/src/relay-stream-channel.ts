import {
	PROXY_STREAM_CHUNK_BYTES,
	type ProxyStreamCancel,
	type ProxyStreamChunk,
	type ProxyStreamEnd,
	type ProxyStreamStart,
} from "@pstdio/pocketcoder-contracts";

type StreamError = "unreachable" | "deadline" | "too_large" | "streaming_unsupported";

export interface RelayStreamResponse {
	request_id: string;
	status?: number;
	headers: Record<string, string>;
	body?: ReadableStream<Uint8Array>;
	error_code?: StreamError;
}

export interface RelayStreamChannel {
	requestId: string;
	resolve: (response: RelayStreamResponse) => void;
	timer: ReturnType<typeof setTimeout>;
	body: ReadableStream<Uint8Array>;
	controller: ReadableStreamDefaultController<Uint8Array>;
	started: boolean;
	expectedSeq: number;
	totalBytes: number;
	maxBytes: number;
	pendingChunk: { seq: number; bytes: Uint8Array } | null;
	pullWaiting: boolean;
}

interface StreamConnection {
	streams: Map<string, RelayStreamChannel>;
}

type SendStreamFrame<TConnection> = (
	connection: TConnection,
	type: "proxy_stream_ack" | "proxy_stream_cancel",
	payload: unknown,
) => void;

export class RelayStreamRegistry<TConnection extends StreamConnection> {
	constructor(
		private readonly isLive: (connection: TConnection) => boolean,
		private readonly send: SendStreamFrame<TConnection>,
	) {}

	open(
		connection: TConnection,
		requestId: string,
		maxBytes: number,
		deadlineMs: number,
	): Promise<RelayStreamResponse> {
		return new Promise((resolve) => {
			let controller!: ReadableStreamDefaultController<Uint8Array>;
			let channel!: RelayStreamChannel;
			const body = new ReadableStream<Uint8Array>(
				{
					start(value) {
						controller = value;
					},
					pull: () => {
						channel.pullWaiting = true;
						this.flush(connection, channel);
					},
					cancel: () => {
						this.cancel(connection, requestId, "downstream_closed", false);
					},
				},
				{ highWaterMark: 0 },
			);
			const timer = setTimeout(() => {
				this.fail(connection, requestId, "deadline", "deadline");
			}, deadlineMs);
			channel = {
				requestId,
				resolve,
				timer,
				body,
				controller,
				started: false,
				expectedSeq: 0,
				totalBytes: 0,
				maxBytes,
				pendingChunk: null,
				pullWaiting: false,
			};
			connection.streams.set(requestId, channel);
		});
	}

	start(connection: TConnection, payload: ProxyStreamStart): void {
		const channel = this.channel(connection, payload.request_id);
		if (!channel || channel.started) return;
		channel.started = true;
		channel.resolve({
			request_id: payload.request_id,
			status: payload.status,
			headers: payload.headers,
			body: channel.body,
		});
	}

	push(connection: TConnection, payload: ProxyStreamChunk): void {
		const channel = this.channel(connection, payload.request_id);
		if (!channel?.started || channel.pendingChunk || payload.seq !== channel.expectedSeq) {
			return;
		}
		const bytes = Uint8Array.from(Buffer.from(payload.content_b64, "base64"));
		if (
			bytes.byteLength > PROXY_STREAM_CHUNK_BYTES ||
			channel.totalBytes + bytes.byteLength > channel.maxBytes
		) {
			this.fail(connection, payload.request_id, "too_large", "too_large");
			return;
		}
		channel.totalBytes += bytes.byteLength;
		channel.expectedSeq += 1;
		channel.pendingChunk = { seq: payload.seq, bytes };
		this.flush(connection, channel);
	}

	end(connection: TConnection, payload: ProxyStreamEnd): void {
		const channel = this.channel(connection, payload.request_id);
		if (!channel) return;
		if (payload.error_code) {
			this.fail(connection, payload.request_id, payload.error_code);
			return;
		}
		if (!channel.started) {
			this.finish(connection, channel);
			channel.resolve({
				request_id: payload.request_id,
				headers: {},
				error_code: "unreachable",
			});
			return;
		}
		channel.controller.close();
		this.finish(connection, channel);
	}

	cancel(
		connection: TConnection,
		requestId: string,
		reason: ProxyStreamCancel["reason"],
		errorBody = true,
	): void {
		const channel = this.channel(connection, requestId);
		if (!channel) return;
		this.send(connection, "proxy_stream_cancel", { request_id: requestId, reason });
		if (!channel.started) {
			channel.resolve({ request_id: requestId, headers: {}, error_code: "unreachable" });
		} else if (errorBody) {
			channel.controller.error(new Error(`relay stream canceled: ${reason}`));
		}
		this.finish(connection, channel);
	}

	drop(connection: TConnection): void {
		for (const channel of connection.streams.values()) {
			clearTimeout(channel.timer);
			if (channel.started) {
				channel.controller.error(new Error("workspace disconnected"));
			} else {
				channel.resolve({
					request_id: channel.requestId,
					headers: {},
					error_code: "unreachable",
				});
			}
		}
		connection.streams.clear();
	}

	private flush(connection: TConnection, channel: RelayStreamChannel): void {
		if (!channel.pullWaiting || !channel.pendingChunk) return;
		const chunk = channel.pendingChunk;
		channel.pendingChunk = null;
		channel.pullWaiting = false;
		channel.controller.enqueue(chunk.bytes);
		this.send(connection, "proxy_stream_ack", {
			request_id: channel.requestId,
			seq: chunk.seq,
		});
	}

	private fail(
		connection: TConnection,
		requestId: string,
		errorCode: Exclude<StreamError, "streaming_unsupported">,
		cancelReason?: ProxyStreamCancel["reason"],
	): void {
		const channel = this.channel(connection, requestId);
		if (!channel) return;
		if (cancelReason) {
			this.send(connection, "proxy_stream_cancel", {
				request_id: requestId,
				reason: cancelReason,
			});
		}
		if (channel.started) {
			channel.controller.error(new Error(`relay stream failed: ${errorCode}`));
		} else {
			channel.resolve({ request_id: requestId, headers: {}, error_code: errorCode });
		}
		this.finish(connection, channel);
	}

	private channel(connection: TConnection, requestId: string): RelayStreamChannel | undefined {
		if (!this.isLive(connection)) return undefined;
		return connection.streams.get(requestId);
	}

	private finish(connection: TConnection, channel: RelayStreamChannel): void {
		clearTimeout(channel.timer);
		if (connection.streams.get(channel.requestId) === channel) {
			connection.streams.delete(channel.requestId);
		}
	}
}
