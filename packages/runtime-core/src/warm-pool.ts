import { randomUUID } from "node:crypto";
import {
	digestOf,
	type PoolProviderInput,
	type ProviderInput,
	parseDurationMs,
	type TemplateSnapshot,
} from "@pstdio/pocketcoder-contracts";
import type { ProviderRef, WorkspaceDriver } from "./driver";
import type { SecretFactory } from "./scheduler";
import type { Store, TemplateRow, WarmPoolRuntimeRow, WorkspaceRow } from "./types";

export interface WarmPoolConfigEntry {
	template: string;
	version?: string;
	minReady: number;
	maxWarmAgeMs: number;
	missPolicy: "cold" | "wait";
	waitTimeoutMs: number;
}

export interface ResolvedWarmPool extends WarmPoolConfigEntry {
	templateRow: TemplateRow;
	eligibilityFingerprint: string;
}

export interface WarmPoolConnections {
	assign(runtimeId: string, input: ProviderInput): boolean;
	isConnected(runtimeId: string): boolean;
	close(runtimeId: string): void;
}

export interface WarmPoolMetrics {
	warmHits: number;
	misses: number;
	leaseFailures: number;
	replenishFailures: number;
	staleCleanups: number;
	leaseLatencyMsTotal: number;
}

export interface WarmPoolInventoryItem {
	template: string;
	version: string;
	template_digest: string;
	driver: string;
	desired: number;
	counts: Record<string, number>;
	oldest_ready_age_ms: number | null;
}

export interface WarmPoolInventory {
	items: WarmPoolInventoryItem[];
	metrics: WarmPoolMetrics & { average_lease_latency_ms: number };
}

export function warmPoolFingerprint(template: TemplateRow, driverKind: string): string {
	return digestOf({ template_digest: template.digest, driver: driverKind });
}

export function validateWarmPoolTemplate(template: TemplateRow): void {
	if (template.spec.persistence.mounts.length > 0) {
		throw new Error(
			`warm pool ${template.name}@${template.version} is ineligible: persistent mounts are not supported`,
		);
	}
	if (JSON.stringify(template.spec).includes('"secretRef:')) {
		throw new Error(
			`warm pool ${template.name}@${template.version} is ineligible: resolved secret mounts are not supported`,
		);
	}
}

export async function resolveWarmPools(
	store: Store,
	entries: WarmPoolConfigEntry[],
	driverKind: string,
	globalLimit: number,
): Promise<ResolvedWarmPool[]> {
	if (entries.reduce((sum, entry) => sum + entry.minReady, 0) > globalLimit) {
		throw new Error("warm pool desired capacity exceeds POCKETCODER_MAX_ACTIVE_WORKSPACES");
	}
	const seen = new Set<string>();
	const resolved: ResolvedWarmPool[] = [];
	for (const entry of entries) {
		const template = await store.getTemplate(entry.template, entry.version);
		if (!template || template.status === "retired") {
			throw new Error(
				`warm pool template not found: ${entry.template}${entry.version ? `@${entry.version}` : ""}`,
			);
		}
		validateWarmPoolTemplate(template);
		if (seen.has(template.digest))
			throw new Error(`duplicate warm pool template digest: ${template.digest}`);
		seen.add(template.digest);
		resolved.push({
			...entry,
			templateRow: template,
			eligibilityFingerprint: warmPoolFingerprint(template, driverKind),
		});
	}
	return resolved;
}

export class WarmPoolManager {
	readonly metrics: WarmPoolMetrics = {
		warmHits: 0,
		misses: 0,
		leaseFailures: 0,
		replenishFailures: 0,
		staleCleanups: 0,
		leaseLatencyMsTotal: 0,
	};

	constructor(
		private readonly deps: {
			store: Store;
			driver: WorkspaceDriver;
			connections: WarmPoolConnections;
			secrets: SecretFactory;
			workspaceServerUrl: string;
			pools: ResolvedWarmPool[];
			now?: () => Date;
			onError?: (context: string, error: unknown) => void;
		},
	) {}

	private now(): Date {
		return this.deps.now?.() ?? new Date();
	}
	private poolFor(row: WorkspaceRow): ResolvedWarmPool | undefined {
		return this.deps.pools.find((pool) => pool.templateRow.digest === row.templateDigest);
	}

	missDecision(row: WorkspaceRow): "cold" | "wait" {
		const pool = this.poolFor(row);
		if (!pool || pool.missPolicy === "cold") return "cold";
		return this.now().getTime() - row.createdAt.getTime() < pool.waitTimeoutMs ? "wait" : "cold";
	}

	async tryLease(
		row: WorkspaceRow,
		input: ProviderInput,
		registrationDigest: Uint8Array,
		registrationExpiresAt: Date,
	): Promise<boolean> {
		const pool = this.poolFor(row);
		if (!pool) return false;
		const started = this.now();
		const claimed = await this.deps.store.claimWarmPoolRuntime({
			workspaceId: row.id,
			templateDigest: row.templateDigest,
			driverKind: this.deps.driver.kind,
			eligibilityFingerprint: pool.eligibilityFingerprint,
			registrationDigest,
			registrationExpiresAt,
			at: started,
		});
		if (!claimed) {
			this.metrics.misses += 1;
			return false;
		}
		await this.deps.store.updateWarmPoolRuntime(
			claimed.runtime.id,
			{ state: "leased" },
			this.now(),
		);
		if (!this.deps.connections.assign(claimed.runtime.id, input)) {
			this.metrics.leaseFailures += 1;
			await this.destroy(claimed.runtime, "assignment_connection_lost");
			await this.deps.store.transition(row.id, {
				from: ["provisioning"],
				to: "queued",
				at: this.now(),
				patch: {
					providerKind: null,
					providerRef: null,
					provisioningMode: null,
					registrationDigest: null,
					registrationExpiresAt: null,
				},
			});
			return false;
		}
		this.metrics.warmHits += 1;
		this.metrics.leaseLatencyMsTotal += this.now().getTime() - started.getTime();
		return true;
	}

	async markReady(runtimeId: string): Promise<boolean> {
		let row = await this.deps.store.getWarmPoolRuntime(runtimeId);
		// Docker can establish the outbound socket in the small window between
		// `docker run` starting and createWarm persisting its returned ref.
		for (
			let attempt = 0;
			row?.state === "provisioning" && !row.providerRef && attempt < 50;
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			row = await this.deps.store.getWarmPoolRuntime(runtimeId);
		}
		if (row?.state !== "provisioning" || !row.providerRef) return false;
		const now = this.now();
		await this.deps.store.updateWarmPoolRuntime(
			runtimeId,
			{
				state: "ready",
				readyAt: now,
				enrollmentDigest: null,
				enrollmentExpiresAt: null,
			},
			now,
		);
		void this.deps.driver.cleanupWarmInput?.(runtimeId).catch(() => {});
		return true;
	}

	async disconnected(runtimeId: string): Promise<void> {
		const row = await this.deps.store.getWarmPoolRuntime(runtimeId);
		if (row && ["provisioning", "ready", "leasing"].includes(row.state)) {
			await this.destroy(row, "pool_agent_disconnected");
		}
	}

	private async destroy(row: WarmPoolRuntimeRow, reason: string): Promise<void> {
		await this.deps.store.updateWarmPoolRuntime(
			row.id,
			{ state: "draining", failureCode: reason },
			this.now(),
		);
		this.deps.connections.close(row.id);
		if (row.providerRef) {
			await this.deps.driver.stop(row.providerRef as ProviderRef, 1).catch(() => {});
			await this.deps.driver.remove(row.providerRef as ProviderRef).catch(() => {});
		}
		await this.deps.store.updateWarmPoolRuntime(
			row.id,
			{ state: "failed", failureCode: reason },
			this.now(),
		);
	}

	private async create(pool: ResolvedWarmPool): Promise<void> {
		const now = this.now();
		const id = randomUUID();
		const secret = this.deps.secrets.generate();
		const row: WarmPoolRuntimeRow = {
			id,
			templateId: pool.templateRow.id,
			templateName: pool.templateRow.name,
			templateVersion: pool.templateRow.version,
			templateDigest: pool.templateRow.digest,
			driverKind: this.deps.driver.kind,
			eligibilityFingerprint: pool.eligibilityFingerprint,
			state: "provisioning",
			providerRef: null,
			enrollmentDigest: this.deps.secrets.digest(secret),
			enrollmentExpiresAt: new Date(
				now.getTime() + parseDurationMs(pool.templateRow.spec.timeouts.start),
			),
			workspaceId: null,
			createdAt: now,
			updatedAt: now,
			readyAt: null,
			leasedAt: null,
			failureCode: null,
		};
		await this.deps.store.insertWarmPoolRuntime(row);
		const input: PoolProviderInput = {
			pool_runtime_id: id,
			server_url: this.deps.workspaceServerUrl,
			enrollment_secret: secret,
			template_digest: pool.templateRow.digest,
			template_name: pool.templateRow.name,
			template_version: pool.templateRow.version,
		};
		try {
			const template: TemplateSnapshot = {
				name: pool.templateRow.name,
				version: pool.templateRow.version,
				digest: pool.templateRow.digest,
				spec: pool.templateRow.spec,
			};
			const expiresAt = new Date(
				now.getTime() + pool.maxWarmAgeMs + parseDurationMs(template.spec.timeouts.maxAge),
			);
			const ref = await this.deps.driver.createWarm({
				runtimeId: id,
				template,
				input,
				expiresAt,
			});
			await this.deps.store.updateWarmPoolRuntime(id, { providerRef: ref }, this.now());
		} catch (error) {
			this.metrics.replenishFailures += 1;
			await this.deps.store.updateWarmPoolRuntime(
				id,
				{ state: "failed", failureCode: "provider_create_failed" },
				this.now(),
			);
			this.deps.onError?.(`warm-pool.create.${id}`, error);
		}
	}

	private async cleanupReason(
		row: WarmPoolRuntimeRow,
		pool: ResolvedWarmPool | undefined,
		now: Date,
	): Promise<string | null> {
		if (!pool) return "pool_retired";
		if (
			["provisioning", "ready"].includes(row.state) &&
			row.createdAt.getTime() + pool.maxWarmAgeMs <= now.getTime()
		)
			return "max_warm_age";
		if (
			row.state === "provisioning" &&
			row.enrollmentExpiresAt !== null &&
			row.enrollmentExpiresAt <= now
		) {
			return "enrollment_timeout";
		}
		if (!row.workspaceId) return null;
		return (await this.deps.store.getWorkspace(row.workspaceId))?.terminalAt
			? "workspace_ended"
			: null;
	}

	private async reconcileRow(
		row: WarmPoolRuntimeRow,
		pool: ResolvedWarmPool | undefined,
		now: Date,
	): Promise<void> {
		const reason = await this.cleanupReason(row, pool, now);
		if (reason) {
			if (row.state !== "failed") {
				this.metrics.staleCleanups += 1;
				await this.destroy(row, reason);
			}
			return;
		}
		if (!row.providerRef || ["failed", "draining"].includes(row.state)) return;
		const state = await this.deps.driver.inspect(row.providerRef as ProviderRef);
		if (!state.exists || !state.running) await this.destroy(row, "provider_lost");
	}

	async reconcile(): Promise<void> {
		const now = this.now();
		const configured = new Map(this.deps.pools.map((pool) => [pool.templateRow.digest, pool]));
		const rows = await this.deps.store.listWarmPoolRuntimes();
		const known = new Map(rows.map((row) => [row.id, row]));
		for (const provider of await this.deps.driver.listWarm()) {
			const row = known.get(provider.runtimeId);
			if (
				!row ||
				row.templateDigest !== provider.templateDigest ||
				row.driverKind !== this.deps.driver.kind
			) {
				this.metrics.staleCleanups += 1;
				await this.deps.driver.stop(provider.ref, 1).catch(() => {});
				await this.deps.driver.remove(provider.ref).catch(() => {});
				continue;
			}
			if (!row.providerRef && row.state === "provisioning") {
				await this.deps.store.updateWarmPoolRuntime(row.id, { providerRef: provider.ref }, now);
				row.providerRef = provider.ref;
			}
		}
		for (const row of rows) {
			await this.reconcileRow(row, configured.get(row.templateDigest), now);
		}
		const fresh = await this.deps.store.listWarmPoolRuntimes();
		for (const pool of this.deps.pools) {
			const available = fresh.filter(
				(row) =>
					row.templateDigest === pool.templateRow.digest &&
					["provisioning", "ready"].includes(row.state),
			).length;
			for (let i = available; i < pool.minReady; i += 1) await this.create(pool);
		}
	}

	async inventory(): Promise<WarmPoolInventory> {
		const rows = await this.deps.store.listWarmPoolRuntimes();
		const now = this.now();
		return {
			items: this.deps.pools.map((pool) => {
				const matching = rows.filter((row) => row.templateDigest === pool.templateRow.digest);
				const counts: Record<string, number> = {};
				for (const row of matching) counts[row.state] = (counts[row.state] ?? 0) + 1;
				const ready = matching
					.filter((row) => row.state === "ready" && row.readyAt)
					.map((row) => row.readyAt as Date);
				return {
					template: pool.templateRow.name,
					version: pool.templateRow.version,
					template_digest: pool.templateRow.digest,
					driver: this.deps.driver.kind,
					desired: pool.minReady,
					counts,
					oldest_ready_age_ms: ready.length
						? now.getTime() - Math.min(...ready.map((date) => date.getTime()))
						: null,
				};
			}),
			metrics: {
				...this.metrics,
				average_lease_latency_ms: this.metrics.warmHits
					? this.metrics.leaseLatencyMsTotal / this.metrics.warmHits
					: 0,
			},
		};
	}
}
