import type {
	AttachmentAck,
	AttachmentResolved,
	AttachmentResult,
} from "@pstdio/pocketcoder-contracts";

export type AttachmentEvent =
	| { kind: "ack"; payload: AttachmentAck }
	| { kind: "result"; payload: AttachmentResult }
	| { kind: "resolved"; payload: AttachmentResolved };

export interface AttachmentChannel {
	queue: AttachmentEvent[];
	waiter: ((event: AttachmentEvent | null) => void) | null;
}

export class AttachmentRegistry<
	TConnection extends { attachments: Map<string, AttachmentChannel> },
> {
	constructor(private readonly isLive: (connection: TConnection) => boolean) {}

	open(connection: TConnection, operationId: string): void {
		connection.attachments.set(operationId, { queue: [], waiter: null });
	}

	close(connection: TConnection, operationId: string): void {
		const channel = connection.attachments.get(operationId);
		if (!channel) return;
		connection.attachments.delete(operationId);
		channel.waiter?.(null);
	}

	push(connection: TConnection, event: AttachmentEvent): void {
		if (!this.isLive(connection)) return;
		const channel = connection.attachments.get(event.payload.operation_id);
		if (!channel) return;
		if (channel.waiter) {
			const waiter = channel.waiter;
			channel.waiter = null;
			waiter(event);
			return;
		}
		channel.queue.push(event);
	}

	next(
		connection: TConnection,
		operationId: string,
		timeoutMs: number,
	): Promise<AttachmentEvent | null> {
		const channel = connection.attachments.get(operationId);
		if (!channel) return Promise.resolve(null);
		const queued = channel.queue.shift();
		if (queued) return Promise.resolve(queued);
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (channel.waiter === waiter) channel.waiter = null;
				resolve(null);
			}, timeoutMs);
			const waiter = (event: AttachmentEvent | null) => {
				clearTimeout(timer);
				resolve(event);
			};
			channel.waiter = waiter;
		});
	}

	drop(connection: TConnection): void {
		for (const channel of connection.attachments.values()) channel.waiter?.(null);
		connection.attachments.clear();
	}
}
