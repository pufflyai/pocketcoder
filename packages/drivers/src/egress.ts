import { issueEgressAuditToken } from "@pstdio/pocketcoder-auth";
import type {
	NetworkPolicy,
	PoolProviderInput,
	ProviderInput,
} from "@pstdio/pocketcoder-contracts";

const EGRESS_CONTROL_URL = "http://127.0.0.1:18081";

export interface EgressDriverOptions {
	egressImage?: string;
	egressSigningKey?: string;
}

export function workspaceInput(input: ProviderInput): ProviderInput {
	return { ...input, server_url: EGRESS_CONTROL_URL };
}

export function poolInput(input: PoolProviderInput): PoolProviderInput {
	return { ...input, server_url: EGRESS_CONTROL_URL };
}

export function egressConfig(
	options: EgressDriverOptions,
	input: ProviderInput | PoolProviderInput,
	policy: NetworkPolicy,
	expiresAt: Date,
) {
	if (!options.egressImage || !options.egressSigningKey) {
		throw new Error("restricted workspace requires POCKETCODER_EGRESS_IMAGE and signing key");
	}
	const subject =
		"workspace_id" in input
			? { kind: "workspace" as const, id: input.workspace_id }
			: { kind: "pool" as const, id: input.pool_runtime_id };
	return {
		policy,
		control_url: input.server_url,
		audit_url: `${input.server_url.replace(/\/$/, "")}/v1/internal/egress/events`,
		audit_token: issueEgressAuditToken(options.egressSigningKey, { ...subject, expiresAt }),
	};
}
