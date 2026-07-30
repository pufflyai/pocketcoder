import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "./types";

// Builds the signed lifecycle event payload for a state transition. Inserted
// into the outbox in the same transaction as the transition by every store.

export function buildEventEnvelope(row: WorkspaceRow, occurredAt: Date): EventEnvelope {
	return {
		id: randomUUID(),
		type: `workspace.${row.state}`,
		occurred_at: occurredAt.toISOString(),
		workspace: {
			id: row.id,
			external_id: row.externalId,
			state: row.state,
			reason_code: row.reasonCode,
			template: {
				name: row.templateName,
				version: row.templateVersion,
				digest: row.templateDigest,
			},
			origin_workspace_id: row.originWorkspaceId,
			restored_from_checkpoint_id: row.restoredFromCheckpointId,
			latest_checkpoint_id: row.latestCheckpointId,
			outputs: row.outputs,
		},
	};
}
