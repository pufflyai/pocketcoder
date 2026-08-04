import { redact } from "@pstdio/pocketcoder-auth";
import { parseDurationMs } from "@pstdio/pocketcoder-contracts";
import type {
	StorageRef,
	WorkspaceDriver,
	WorkspaceSecretResolver,
	WorkspaceStorageDriver,
} from "./driver";
import type { MetricSink } from "./metrics";
import type {
	LogStore,
	PersistenceStore,
	WorkspacePatch,
	WorkspaceRow,
	WorkspaceStore,
} from "./types";
import type { WarmPoolManager } from "./warm-pool";

export const FAILURE_LOG_TAIL_BYTES = 16 * 1024;

export function decodeFailureLogTail(content: Uint8Array, truncated: boolean): string {
	let start = 0;
	if (truncated) {
		while (start < content.byteLength && ((content[start] as number) & 0xc0) === 0x80) {
			start += 1;
		}
	}
	let text = new TextDecoder().decode(content.subarray(start));
	if (truncated) {
		const firstNewline = text.indexOf("\n");
		if (firstNewline >= 0) text = text.slice(firstNewline + 1);
	}
	return redact(text);
}

function failureLogContent(error: unknown): Uint8Array {
	const message = redact(error instanceof Error ? error.message : String(error));
	const encoded = new TextEncoder().encode(`workspace launch failed: ${message}\n`);
	if (encoded.byteLength <= FAILURE_LOG_TAIL_BYTES) return encoded;
	const bounded = encoded.subarray(0, FAILURE_LOG_TAIL_BYTES - 1);
	return new TextEncoder().encode(`${new TextDecoder().decode(bounded).replace(/\uFFFD$/, "")}\n`);
}

// Admission, expiry, and termination. One logical execution path: queued
// workspaces launch through the configured driver in fair FIFO order within
// principal/template/global capacity. Capacity pressure queues work; it never
// routes to a shared executor.

export interface AdmissionLimits {
	globalActiveWorkspaces: number;
	perPrincipalActiveWorkspaces: number;
	perTemplateActiveWorkspaces: Record<string, number>;
	maxQueuedWorkspaces: number;
	maxQueueAgeMs: number;
	maxLaunchAttempts: number;
}

export const DEFAULT_LIMITS: AdmissionLimits = {
	globalActiveWorkspaces: 100,
	perPrincipalActiveWorkspaces: 20,
	perTemplateActiveWorkspaces: {},
	maxQueuedWorkspaces: 1000,
	maxQueueAgeMs: 30 * 60_000,
	maxLaunchAttempts: 3,
};

// The live-connection surface the scheduler needs; implemented by the
// server's WSS hub. It reports nothing durable.
export interface ConnectionHub {
	isConnected(workspaceId: string): boolean;
	shutdown(workspaceId: string, reason: string): boolean;
	signal(workspaceId: string, signal: "TERM" | "KILL"): boolean;
	close(workspaceId: string): void;
}

export interface SecretFactory {
	generate(): string;
	digest(secret: string): Uint8Array;
}

export interface SchedulerDeps {
	store: WorkspaceStore & PersistenceStore & LogStore;
	driver: WorkspaceDriver;
	storageDriver?: WorkspaceStorageDriver;
	secretResolver?: WorkspaceSecretResolver;
	connections: ConnectionHub;
	secrets: SecretFactory;
	limits: AdmissionLimits;
	// URL workspaces use to reach this server (may differ from listen addr).
	workspaceServerUrl: string;
	warmPool?: WarmPoolManager;
	preserveByPolicy?: (
		row: WorkspaceRow,
		trigger: "idle" | "deadline" | "clean_exit" | "failure",
	) => Promise<boolean>;
	now?: () => Date;
	onError?: (context: string, err: unknown) => void;
	metrics?: MetricSink;
}

export class SchedulerBase {
	protected readonly deps: SchedulerDeps;
	protected lastAdmittedPrincipal: string | null = null;
	protected activeTick: Promise<void> | null = null;

	constructor(deps: SchedulerDeps) {
		this.deps = deps;
	}

	protected now(): Date {
		return this.deps.now ? this.deps.now() : new Date();
	}

	protected timeoutMs(
		row: WorkspaceRow,
		key: "start" | "maxAge" | "idle" | "disconnectGrace" | "terminateGrace",
	): number {
		return parseDurationMs(row.templateSnapshot.spec.timeouts[key]);
	}

	protected graceSeconds(row: WorkspaceRow): number {
		return Math.max(1, Math.ceil(this.timeoutMs(row, "terminateGrace") / 1000));
	}

	protected report(context: string, err: unknown): void {
		this.deps.onError?.(context, err);
	}

	protected async captureLaunchFailure(
		workspaceId: string,
		error: unknown,
		at: Date,
	): Promise<WorkspacePatch> {
		const { store } = this.deps;
		try {
			await store.appendLogs(workspaceId, [
				{
					stream: "runtime",
					occurredAt: at,
					content: failureLogContent(error),
				},
			]);
			const tail = await store.readLogTail(workspaceId, FAILURE_LOG_TAIL_BYTES);
			return {
				failureLogTail: decodeFailureLogTail(tail.content, tail.truncated),
				failureLogTailTruncated: tail.truncated,
				failureLastLogSeq: tail.lastSeq,
			};
		} catch (captureError) {
			this.report(`launch.log.${workspaceId}`, captureError);
			return {};
		}
	}

	protected async cleanupWorkspaceStorage(row: WorkspaceRow): Promise<void> {
		const storageDriver = this.deps.storageDriver;
		if (!storageDriver) return;
		const storage = await this.deps.store.getWorkspaceStorage(row.id);
		if (!storage || ["retained", "deleted"].includes(storage.state)) return;
		try {
			if (Object.keys(storage.providerRef).length > 0) {
				await storageDriver.deleteStorage(storage.providerRef as StorageRef);
			}
			const at = this.now();
			await this.deps.store.updateWorkspaceStorage(
				storage.id,
				{ state: "deleted", deletedAt: at },
				at,
			);
		} catch (error) {
			await this.deps.store.updateWorkspaceStorage(
				storage.id,
				{ lastErrorCode: "storage_cleanup_failed" },
				this.now(),
			);
			this.report(`storage.cleanup.${row.id}`, error);
		}
	}

	protected async finishRestoreOperation(
		row: WorkspaceRow,
		state: "succeeded" | "failed",
		reasonCode: string | null,
	): Promise<void> {
		const operation = (await this.deps.store.listIncompleteOperations()).find(
			(candidate) => candidate.kind === "restore" && candidate.resultWorkspaceId === row.id,
		);
		if (!operation) return;
		const at = this.now();
		await this.deps.store.updateOperation(
			operation.id,
			{ state, reasonCode, completedAt: at, attemptCount: operation.attemptCount + 1 },
			at,
		);
	}
}
