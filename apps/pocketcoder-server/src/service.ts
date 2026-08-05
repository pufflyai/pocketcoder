import { randomUUID } from "node:crypto";
import {
	ApiError,
	canonicalJson,
	digestOf,
	isTerminal,
	parseDurationMs,
	type TemplateSnapshot,
	templateServices,
	type WorkspaceCreateRequest,
	type WorkspaceResource,
} from "@pstdio/pocketcoder-contracts";
import type {
	AdmissionLimits,
	PrincipalRow,
	Scheduler,
	TemplateRow,
	TemplateStore,
	WorkspaceRow,
	WorkspaceStore,
} from "@pstdio/pocketcoder-runtime-core";

// Application service behind the workspace routes. Handlers stay focused on
// request flow; scheduling, SQL, and driver logic live below this layer.

export interface WorkspaceServiceDeps {
	store: TemplateStore & WorkspaceStore;
	scheduler: Scheduler;
	limits: AdmissionLimits;
	now?: () => Date;
}

export function templateAuthorized(principal: PrincipalRow, templateName: string): boolean {
	return principal.templateNames.includes("*") || principal.templateNames.includes(templateName);
}

export function toResource(row: WorkspaceRow): WorkspaceResource {
	return {
		id: row.id,
		external_id: row.externalId,
		template: {
			name: row.templateName,
			version: row.templateVersion,
			digest: row.templateDigest,
		},
		state: row.state,
		reason_code: row.reasonCode,
		agent_state: row.agentState,
		network: { state: row.networkState },
		change_cursor: row.changeSeq,
		provider_kind: row.providerKind,
		provisioning_mode: row.provisioningMode,
		health: row.health,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
		connected_at: row.connectedAt?.toISOString() ?? null,
		ready_at: row.readyAt?.toISOString() ?? null,
		deadline_at: row.deadlineAt.toISOString(),
		terminal_at: row.terminalAt?.toISOString() ?? null,
		metadata: row.metadata,
		origin_workspace_id: row.originWorkspaceId,
		restored_from_checkpoint_id: row.restoredFromCheckpointId,
		source: row.sourceDescriptor
			? {
					kind: "git",
					repository: row.sourceDescriptor.repository,
					requested_revision: row.sourceDescriptor.revision,
					resolved_commit: row.resolvedSource?.resolved_commit ?? null,
				}
			: null,
		persistence: {
			enabled: row.templateSnapshot.spec.persistence.mounts.length > 0,
			conversation_restore: row.persistenceCapability,
			conversation_resume:
				row.persistenceCapability === "supported"
					? { status: "supported", reason: null }
					: row.persistenceCapability === "filesystem_only"
						? { status: "unsupported", reason: "filesystem_only" }
						: { status: "unknown", reason: "capability_unknown" },
			latest_checkpoint_id: row.latestCheckpointId,
		},
		outputs: row.outputs,
		failure:
			row.state === "failed" && row.reasonCode
				? {
						reason_code: row.reasonCode,
						log_tail: row.failureLogTail ?? "",
						log_tail_truncated: row.failureLogTailTruncated,
						last_log_seq: row.failureLastLogSeq,
					}
				: null,
	};
}

export class WorkspaceService {
	private activeWaiters = 0;
	private readonly waitersByWorkspace = new Map<string, number>();

	constructor(private readonly deps: WorkspaceServiceDeps) {}

	private now(): Date {
		return this.deps.now ? this.deps.now() : new Date();
	}

	private async activeTemplate(principal: PrincipalRow, body: WorkspaceCreateRequest) {
		if (!templateAuthorized(principal, body.template.name)) {
			throw new ApiError(
				"template.not_authorized",
				`Principal is not authorized for template ${body.template.name}.`,
			);
		}
		const template = await this.deps.store.getTemplate(body.template.name, body.template.version);
		if (!template) {
			const existsAtAll = (await this.deps.store.listTemplates([body.template.name])).length > 0;
			if (body.template.version && existsAtAll) {
				throw new ApiError(
					"template.version_not_found",
					`Template ${body.template.name} has no version ${body.template.version}.`,
				);
			}
			throw new ApiError("template.not_found", `Unknown template: ${body.template.name}.`);
		}
		if (template.status === "retired") {
			throw new ApiError(
				"template.version_not_found",
				`Template version ${template.name}@${template.version} is retired.`,
			);
		}
		return template;
	}

	private validateCreateInput(template: TemplateRow, body: WorkspaceCreateRequest): void {
		if (
			body.launch_input !== undefined &&
			Buffer.byteLength(canonicalJson(body.launch_input)) > template.spec.maxLaunchInputBytes
		) {
			throw new ApiError(
				"validation.invalid",
				`launch_input exceeds the template limit of ${template.spec.maxLaunchInputBytes} bytes.`,
			);
		}
		if (
			body.source &&
			(!template.spec.source || !(body.source.repository in template.spec.source.repositories))
		) {
			throw new ApiError(
				"source.not_allowed",
				"The selected repository alias is not declared by this template.",
			);
		}
	}

	async create(
		principal: PrincipalRow,
		body: WorkspaceCreateRequest,
		idempotencyKey: string,
	): Promise<{ workspace: WorkspaceRow; created: boolean }> {
		const { store, limits } = this.deps;
		const requestDigest = digestOf(body);
		const replay = await store.getWorkspaceByIdempotency(principal.id, idempotencyKey);
		if (replay) {
			if (replay.requestDigest !== requestDigest) {
				throw new ApiError(
					"idempotency.conflict",
					"This Idempotency-Key was already used with a different request.",
				);
			}
			return { workspace: replay, created: false };
		}
		const template = await this.activeTemplate(principal, body);
		const snapshot: TemplateSnapshot = {
			name: template.name,
			version: template.version,
			digest: template.digest,
			spec: template.spec,
			services: templateServices(template.spec),
		};
		this.validateCreateInput(template, body);
		const now = this.now();
		const result = await store.insertWorkspace(
			{
				id: randomUUID(),
				principalId: principal.id,
				externalId: body.external_id,
				idempotencyKey,
				requestDigest,
				templateId: template.id,
				templateSnapshot: snapshot,
				launchInput: body.launch_input ?? null,
				metadata: body.metadata ?? {},
				sourceDescriptor: body.source ?? null,
				persistenceCapability: template.spec.persistence.conversationRestore,
				launchMode: "create",
				deadlineAt: new Date(now.getTime() + parseDurationMs(template.spec.timeouts.maxAge)),
				createdAt: now,
			},
			{ maxQueuedWorkspaces: limits.maxQueuedWorkspaces },
		);
		if (result.kind === "capacity_exceeded") {
			throw new ApiError("capacity.queue_full", "The workspace queue is full; retry later.");
		}
		if (result.kind === "conflict") {
			if (result.conflict === "external_id") {
				throw new ApiError(
					"workspace.external_id_conflict",
					"The external_id is already active for another workspace.",
				);
			}
			throw new ApiError(
				"idempotency.conflict",
				"This Idempotency-Key was already used with a different request.",
			);
		}
		const created = result.kind === "created";
		if (created) {
			// Nudge admission without waiting for the next interval tick.
			void this.deps.scheduler.tick().catch(() => {});
		}
		return { workspace: result.workspace, created };
	}

	async getOwned(principal: PrincipalRow, id: string): Promise<WorkspaceRow> {
		const row = await this.deps.store.getWorkspace(id);
		if (!row || row.principalId !== principal.id) {
			throw new ApiError("workspace.not_found", "Unknown workspace.");
		}
		return row;
	}

	async waitForChange(
		principal: PrincipalRow,
		id: string,
		after: number,
		waitSeconds: number,
		signal?: AbortSignal,
	): Promise<{ workspace: WorkspaceRow; changed: boolean }> {
		const deadline = Date.now() + waitSeconds * 1000;
		while (true) {
			const workspace = await this.getOwned(principal, id);
			const changed = workspace.changeSeq > after;
			if (changed || isTerminal(workspace.state) || waitSeconds === 0 || Date.now() >= deadline) {
				return { workspace, changed };
			}
			const workspaceWaiters = this.waitersByWorkspace.get(id) ?? 0;
			if (this.activeWaiters >= 1000 || workspaceWaiters >= 100) {
				throw new ApiError(
					"capacity.waiters_full",
					"The workspace change-wait capacity is full; retry later.",
				);
			}
			this.activeWaiters += 1;
			this.waitersByWorkspace.set(id, workspaceWaiters + 1);
			try {
				await this.deps.store.waitForWorkspaceChange(
					id,
					after,
					Math.max(1, deadline - Date.now()),
					signal,
				);
			} finally {
				this.activeWaiters -= 1;
				const remaining = (this.waitersByWorkspace.get(id) ?? 1) - 1;
				if (remaining === 0) this.waitersByWorkspace.delete(id);
				else this.waitersByWorkspace.set(id, remaining);
			}
		}
	}

	async cancel(principal: PrincipalRow, id: string): Promise<WorkspaceRow> {
		const { store, scheduler } = this.deps;
		const row = await this.getOwned(principal, id);
		const now = this.now();
		if (row.state === "queued") {
			const updated = await store.transition(row.id, {
				from: ["queued"],
				to: "canceled",
				reason: "canceled_by_caller",
				at: now,
			});
			return updated ?? (await this.getOwned(principal, id));
		}
		if (row.state === "terminating" || row.terminalAt) {
			// Cancellation is idempotent.
			return row;
		}
		await scheduler.beginTermination(row, "canceled", "canceled_by_caller", now);
		return await this.getOwned(principal, id);
	}
}
