import { randomUUID } from "node:crypto";
import {
	ApiError,
	canonicalJson,
	digestOf,
	parseDurationMs,
	type TemplateSnapshot,
	type WorkspaceCreateRequest,
	type WorkspaceResource,
} from "@pocketcoder/contracts";
import type {
	AdmissionLimits,
	PrincipalRow,
	Scheduler,
	Store,
	WorkspaceRow,
} from "@pocketcoder/runtime-core";

// Application service behind the workspace routes. Handlers stay focused on
// request flow; scheduling, SQL, and driver logic live below this layer.

export interface WorkspaceServiceDeps {
	store: Store;
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
		provider_kind: row.providerKind,
		health: row.health,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
		connected_at: row.connectedAt?.toISOString() ?? null,
		ready_at: row.readyAt?.toISOString() ?? null,
		deadline_at: row.deadlineAt.toISOString(),
		terminal_at: row.terminalAt?.toISOString() ?? null,
		metadata: row.metadata,
	};
}

export class WorkspaceService {
	constructor(private readonly deps: WorkspaceServiceDeps) {}

	private now(): Date {
		return this.deps.now ? this.deps.now() : new Date();
	}

	async create(
		principal: PrincipalRow,
		body: WorkspaceCreateRequest,
		idempotencyKey: string,
	): Promise<{ workspace: WorkspaceRow; created: boolean }> {
		const { store, limits } = this.deps;
		if (!templateAuthorized(principal, body.template.name)) {
			throw new ApiError(
				"template.not_authorized",
				`Principal is not authorized for template ${body.template.name}.`,
			);
		}
		const template = await store.getTemplate(body.template.name, body.template.version);
		if (!template) {
			const existsAtAll = (await store.listTemplates([body.template.name])).length > 0;
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
		const snapshot: TemplateSnapshot = {
			name: template.name,
			version: template.version,
			digest: template.digest,
			spec: template.spec,
		};
		if (body.launch_input !== undefined) {
			const size = Buffer.byteLength(canonicalJson(body.launch_input));
			if (size > template.spec.maxLaunchInputBytes) {
				throw new ApiError(
					"validation.invalid",
					`launch_input exceeds the template limit of ${template.spec.maxLaunchInputBytes} bytes.`,
				);
			}
		}
		if ((await store.countQueued()) >= limits.maxQueuedWorkspaces) {
			throw new ApiError("capacity.queue_full", "The workspace queue is full; retry later.");
		}
		const now = this.now();
		const result = await store.insertWorkspace({
			id: randomUUID(),
			principalId: principal.id,
			externalId: body.external_id,
			idempotencyKey,
			requestDigest: digestOf(body),
			templateId: template.id,
			templateSnapshot: snapshot,
			launchInput: body.launch_input ?? null,
			metadata: body.metadata ?? {},
			deadlineAt: new Date(now.getTime() + parseDurationMs(template.spec.timeouts.maxAge)),
			createdAt: now,
		});
		if (result.conflict) {
			throw new ApiError(
				"idempotency.conflict",
				"This Idempotency-Key or external_id was already used with a different request.",
			);
		}
		if (result.created) {
			// Nudge admission without waiting for the next interval tick.
			void this.deps.scheduler.tick().catch(() => {});
		}
		return { workspace: result.workspace, created: result.created };
	}

	async getOwned(principal: PrincipalRow, id: string): Promise<WorkspaceRow> {
		const row = await this.deps.store.getWorkspace(id);
		if (!row || row.principalId !== principal.id) {
			throw new ApiError("workspace.not_found", "Unknown workspace.");
		}
		return row;
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
