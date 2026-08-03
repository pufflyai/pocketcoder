export interface RelayTarget {
	mode: "relay";
	baseUrl: string;
	key: string;
	workspaceId: string;
	serviceUrl: string;
}

export interface DirectTarget {
	mode: "direct";
	key: string;
	serviceUrl: string;
}

export interface UnsetTarget {
	mode: "unset";
	baseUrl: string;
	key: string;
}

export type SessionTarget = RelayTarget | DirectTarget | UnsetTarget;

export function relayTarget(baseUrl: string, key: string, workspaceId: string): RelayTarget {
	const base = baseUrl.replace(/\/$/, "");
	return {
		mode: "relay",
		baseUrl: base,
		key,
		workspaceId,
		serviceUrl: `${base}/v1/workspaces/${encodeURIComponent(workspaceId)}/services/agent`,
	};
}

export function targetFromEnvironment(env: NodeJS.ProcessEnv = process.env): SessionTarget {
	const key = env.POCKETCODER_KEY;
	if (!key) throw new Error("POCKETCODER_KEY is required");
	const directUrl = env.POCKETCODER_AGENTAPI_URL;
	if (directUrl) return { mode: "direct", key, serviceUrl: directUrl.replace(/\/$/, "") };

	const baseUrl = (env.POCKETCODER_URL ?? "http://127.0.0.1:7080").replace(/\/$/, "");
	const workspaceId = env.POCKETCODER_WORKSPACE_ID;
	if (!workspaceId) return { mode: "unset", baseUrl, key };
	return relayTarget(baseUrl, key, workspaceId);
}

export class TargetRef {
	private target: SessionTarget;
	private readonly listeners: Array<(target: SessionTarget) => void> = [];

	constructor(initial: SessionTarget) {
		this.target = initial;
	}

	get current(): SessionTarget {
		return this.target;
	}

	set(next: SessionTarget): void {
		this.target = next;
		for (const listener of this.listeners) listener(next);
	}

	onChange(listener: (target: SessionTarget) => void): void {
		this.listeners.push(listener);
	}
}
