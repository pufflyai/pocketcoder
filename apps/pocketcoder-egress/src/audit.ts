import { randomUUID } from "node:crypto";
import type { NetworkEventInput } from "@pstdio/pocketcoder-contracts";

const MAX_EVENTS = 1_000;
const MAX_BYTES = 4 * 1024 * 1024;
const ADMISSION_BYTES = 4_096;

export class AuditQueue {
	private readonly sourceSessionId = randomUUID();
	private readonly events: Array<{ event: NetworkEventInput; bytes: number }> = [];
	private bytes = 0;
	private uploading = false;
	private retryMs = 250;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly endpoint: string,
		private readonly token: string,
	) {}

	canAccept() {
		return this.events.length < MAX_EVENTS && this.bytes + ADMISSION_BYTES <= MAX_BYTES;
	}

	record(event: NetworkEventInput) {
		const bytes = Buffer.byteLength(JSON.stringify(event));
		if (this.events.length >= MAX_EVENTS || this.bytes + bytes > MAX_BYTES) {
			throw new Error("audit buffer full");
		}
		this.events.push({ event, bytes });
		this.bytes += bytes;
		this.schedule(0);
	}

	private schedule(delay: number) {
		if (this.timer || this.uploading) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, delay);
	}

	async flush() {
		if (this.uploading || this.events.length === 0) return;
		this.uploading = true;
		const batch = this.events.slice(0, 100);
		let nextDelay: number | null = null;
		try {
			const response = await fetch(this.endpoint, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					source_session_id: this.sourceSessionId,
					events: batch.map(({ event }) => event),
				}),
			});
			if (!response.ok) throw new Error(`audit upload returned ${response.status}`);
			this.events.splice(0, batch.length);
			this.bytes -= batch.reduce((sum, item) => sum + item.bytes, 0);
			this.retryMs = 250;
			if (this.events.length > 0) nextDelay = 0;
		} catch {
			nextDelay = this.retryMs;
			this.retryMs = Math.min(this.retryMs * 2, 10_000);
		} finally {
			this.uploading = false;
			if (nextDelay !== null) this.schedule(nextDelay);
		}
	}

	close() {
		if (this.timer) clearTimeout(this.timer);
	}
}
