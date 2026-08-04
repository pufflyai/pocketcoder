import {
	canTransition,
	isTerminal,
	parseDurationMs,
	REASON_CODES,
	WORKSPACE_STATES,
} from "@pstdio/pocketcoder-contracts";
import type {
	StateHistoryRow,
	TransitionRequest,
	WorkspacePatch,
	WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-core";
import { PostgresAdmissionStore } from "./store-admission";
import { asDate, enumValue, nullableEnumValue, type Row } from "./store-base";

export class PostgresTransitionStore extends PostgresAdmissionStore {
	protected patchSql(patch: WorkspacePatch, params: unknown[]): string[] {
		const sets: string[] = [];
		for (const [key, column] of Object.entries(PostgresTransitionStore.PATCH_COLUMNS)) {
			if (!(key in patch)) continue;
			const value = (patch as Record<string, unknown>)[key];
			if (PostgresTransitionStore.JSONB_PATCH_KEYS.has(key)) {
				params.push(value == null ? null : JSON.stringify(value));
				sets.push(`${column} = $${params.length}::jsonb`);
			} else {
				params.push(value ?? null);
				sets.push(`${column} = $${params.length}`);
			}
		}
		return sets;
	}

	async updateWorkspace(id: string, patch: WorkspacePatch, at: Date): Promise<void> {
		const params: unknown[] = [id, at];
		const sets = this.patchSql(patch, params);
		const bumpsChange = Object.keys(patch).some((key) =>
			PostgresTransitionStore.CHANGE_PATCH_KEYS.has(key),
		);
		await this.sql.unsafe(
			`UPDATE ${this.t("workspaces")} SET updated_at = $2${
				bumpsChange ? ", change_seq = change_seq + 1" : ""
			}${sets.length ? `, ${sets.join(", ")}` : ""}
			 WHERE id = $1`,
			params,
		);
		if (bumpsChange) this.notifyWorkspaceChange(id);
	}

	async waitForWorkspaceChange(
		id: string,
		afterSeq: number,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		if (timeoutMs <= 0) return;
		await new Promise<void>((resolve, reject) => {
			const waiters = this.changeWaiters.get(id) ?? new Set<() => void>();
			let timer: ReturnType<typeof setTimeout>;
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				waiters.delete(settle);
				if (waiters.size === 0) this.changeWaiters.delete(id);
			};
			const settle = () => {
				cleanup();
				resolve();
			};
			const abort = () => {
				cleanup();
				reject(signal?.reason ?? new Error("workspace change wait aborted"));
			};
			const fail = (error: unknown) => {
				cleanup();
				reject(error);
			};
			waiters.add(settle);
			this.changeWaiters.set(id, waiters);
			timer = setTimeout(settle, timeoutMs);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			void this.getWorkspace(id)
				.then((workspace) => {
					if (!workspace || workspace.changeSeq > afterSeq) settle();
				})
				.catch(fail);
		});
	}

	async transition(id: string, req: TransitionRequest): Promise<WorkspaceRow | null> {
		const workspace = await this.sql.begin(async (tx) => {
			const rows = (await tx.unsafe(
				`SELECT * FROM ${this.t("workspaces")} WHERE id = $1 FOR UPDATE`,
				[id],
			)) as Row[];
			const current = rows[0] ? this.workspaceFromRow(rows[0] as Row) : null;
			if (!current) return null;
			if (!req.from.includes(current.state)) return null;
			if (!canTransition(current.state, req.to)) return null;

			const params: unknown[] = [id, req.to, req.at];
			const sets = [`state = $2`, `updated_at = $3`, "change_seq = change_seq + 1"];
			if (req.reason !== undefined) {
				params.push(req.reason);
				sets.push(`reason_code = $${params.length}`);
			}
			const patch = { ...(req.patch ?? {}) };
			if (isTerminal(req.to)) {
				params.push(req.at);
				sets.push(`terminal_at = $${params.length}`);
				sets.push("launch_input = NULL", "registration_digest = NULL");
				// Postgres rejects duplicate assignments to one column, so
				// patch keys covered by the terminal clears are dropped.
				delete patch.launchInput;
				delete patch.registrationDigest;
			}
			const patchSets = this.patchSql(patch, params);
			sets.push(...patchSets);
			const updated = (await tx.unsafe(
				`UPDATE ${this.t("workspaces")} SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
				params,
			)) as Row[];
			const workspace = this.workspaceFromRow(updated[0] as Row);
			await this.appendHistoryTx(
				tx,
				workspace,
				current.state,
				req.to,
				workspace.reasonCode,
				req.at,
			);
			await this.appendEventTx(tx, workspace, req.at);
			if (isTerminal(req.to)) {
				const expiresAt = new Date(
					req.at.getTime() +
						parseDurationMs(workspace.templateSnapshot.spec.persistence.conversationRetention),
				);
				await tx.unsafe(
					`INSERT INTO ${this.t("workspace_conversations")}
					 (workspace_id, status, expires_at, deleted_at, updated_at)
					 VALUES ($1, 'retained', $2, NULL, $3)
					 ON CONFLICT (workspace_id) DO UPDATE
					 SET expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at
					 WHERE ${this.t("workspace_conversations")}.status <> 'deleted'`,
					[workspace.id, expiresAt, req.at],
				);
			}
			return workspace;
		});
		if (workspace) this.notifyWorkspaceChange(id);
		return workspace;
	}

	async listStateHistory(workspaceId: string): Promise<StateHistoryRow[]> {
		const rows = (await this.sql.unsafe(
			`SELECT * FROM ${this.t("workspace_state_history")}
			 WHERE workspace_id = $1 ORDER BY occurred_at ASC`,
			[workspaceId],
		)) as Row[];
		return rows.map((r) => ({
			id: String(r.id),
			workspaceId: String(r.workspace_id),
			fromState: nullableEnumValue(r.from_state, WORKSPACE_STATES, "history from state"),
			toState: enumValue(r.to_state, WORKSPACE_STATES, "history to state"),
			reasonCode: nullableEnumValue(r.reason_code, REASON_CODES, "history reason code"),
			occurredAt: asDate(r.occurred_at),
		}));
	}

	// --- Storage, checkpoints, operations, and outputs ---
}
