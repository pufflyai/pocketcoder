import type { ProviderInput } from "@pocketcoder/contracts";
import type { WorkspaceRow } from "./types";

// The single workspace-driver contract. Docker (development) and Kubernetes
// (production) implement the same interface; deployment configuration selects
// exactly one driver. Neither templates nor callers can select it.

export interface ProviderRef {
	kind: string;
	id: string;
	[key: string]: unknown;
}

export interface WorkspaceLaunch {
	workspace: WorkspaceRow;
	input: ProviderInput;
}

export interface ProviderState {
	exists: boolean;
	running: boolean;
	exitCode: number | null;
	detail?: string;
}

export interface DiscoveredProvider {
	workspaceId: string;
	templateDigest: string;
	ref: ProviderRef;
}

export interface WorkspaceDriver {
	readonly kind: string;
	create(launch: WorkspaceLaunch): Promise<ProviderRef>;
	inspect(ref: ProviderRef): Promise<ProviderState>;
	// TERM, wait up to graceSeconds, then KILL, then remove the object.
	terminate(ref: ProviderRef, graceSeconds: number): Promise<void>;
	// Every provider object labeled as a pocketcoder workspace, for
	// restart reconciliation and quarantine of unknown objects.
	list(): Promise<DiscoveredProvider[]>;
}
