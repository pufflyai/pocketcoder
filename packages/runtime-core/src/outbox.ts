import {
	EVENT_HEADER_ID,
	EVENT_HEADER_SIGNATURE,
	EVENT_HEADER_TIMESTAMP,
} from "@pstdio/pocketcoder-contracts";
import type { Store } from "./types";

// At-least-once delivery of signed lifecycle events with bounded exponential
// backoff. Consumers deduplicate by event ID and poll for convergence.

export interface OutboxDeps {
	store: Store;
	// Callback URL, or null when no consumer is configured (events are then
	// marked delivered immediately so the outbox stays bounded).
	sinkUrl: string | null;
	sign: (timestamp: string, body: string) => string;
	fetchFn?: typeof fetch;
	now?: () => Date;
	onError?: (context: string, err: unknown) => void;
}

const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 10 * 60_000;

export class OutboxDispatcher {
	private readonly deps: OutboxDeps;

	constructor(deps: OutboxDeps) {
		this.deps = deps;
	}

	private now(): Date {
		return this.deps.now ? this.deps.now() : new Date();
	}

	async tick(limit = 20): Promise<void> {
		const { store, sinkUrl } = this.deps;
		const events = await store.claimDueEvents(this.now(), limit);
		for (const event of events) {
			if (!sinkUrl) {
				await store.markEventDelivered(event.id, this.now());
				continue;
			}
			const body = JSON.stringify(event.payload);
			const timestamp = this.now().toISOString();
			try {
				const fetchFn = this.deps.fetchFn ?? fetch;
				const res = await fetchFn(sinkUrl, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						[EVENT_HEADER_ID]: event.id,
						[EVENT_HEADER_TIMESTAMP]: timestamp,
						[EVENT_HEADER_SIGNATURE]: this.deps.sign(timestamp, body),
					},
					body,
					signal: AbortSignal.timeout(10_000),
				});
				if (res.ok) {
					await store.markEventDelivered(event.id, this.now());
				} else {
					await this.retry(event.id, event.attemptCount, `http_${res.status}`);
				}
			} catch (err) {
				this.deps.onError?.(`outbox.${event.id}`, err);
				await this.retry(event.id, event.attemptCount, "network_error");
			}
		}
	}

	private async retry(id: string, attemptCount: number, errorCode: string): Promise<void> {
		const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attemptCount, MAX_BACKOFF_MS);
		await this.deps.store.markEventFailed(id, errorCode, new Date(this.now().getTime() + backoff));
	}
}
