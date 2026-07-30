import type {
	ReasonCode,
	TemplateSnapshot,
	TemplateSpec,
	WorkspaceState,
} from "@pstdio/pocketcoder-contracts";

// Row shapes shared by the PostgreSQL store and the in-memory test store.
// PostgreSQL is the durable store; the memory store exists for tests and
// single-process development.

export type TemplateStatus = "active" | "available" | "retired";

export interface TemplateRow {
	id: string;
	name: string;
	version: string;
	digest: string;
	description: string | null;
	spec: TemplateSpec;
	status: TemplateStatus;
	createdAt: Date;
	retiredAt: Date | null;
}

export interface PrincipalRow {
	id: string;
	name: string;
	scopes: string[];
	templateNames: string[];
	disabledAt: Date | null;
	createdAt: Date;
}

export interface MachineKeyRow {
	id: string;
	principalId: string;
	secretDigest: Uint8Array;
	scopes: string[];
	createdAt: Date;
	expiresAt: Date | null;
	revokedAt: Date | null;
	lastUsedAt: Date | null;
}

export interface WorkspaceRow {
	id: string;
	principalId: string;
	externalId: string;
	idempotencyKey: string;
	requestDigest: string;
	templateId: string;
	templateName: string;
	templateVersion: string;
	templateDigest: string;
	templateSnapshot: TemplateSnapshot;
	state: WorkspaceState;
	reasonCode: ReasonCode | null;
	// Desired terminal state while `terminating` (e.g. canceled vs expired).
	terminalIntent: WorkspaceState | null;
	launchInput: Record<string, unknown> | null;
	providerKind: string | null;
	providerRef: Record<string, unknown> | null;
	registrationDigest: Uint8Array | null;
	registrationExpiresAt: Date | null;
	reconnectDigest: Uint8Array | null;
	connectionEpoch: number;
	connectedAt: Date | null;
	disconnectedAt: Date | null;
	readyAt: Date | null;
	lastActivityAt: Date | null;
	launchAttempts: number;
	health: Record<string, string>;
	metadata: Record<string, string>;
	deadlineAt: Date;
	createdAt: Date;
	updatedAt: Date;
	terminalAt: Date | null;
}

export interface StateHistoryRow {
	id: string;
	workspaceId: string;
	fromState: WorkspaceState | null;
	toState: WorkspaceState;
	reasonCode: ReasonCode | null;
	occurredAt: Date;
}

export interface OutboxRow {
	id: string;
	workspaceId: string;
	eventType: string;
	payload: unknown;
	occurredAt: Date;
	nextAttemptAt: Date;
	attemptCount: number;
	deliveredAt: Date | null;
	lastErrorCode: string | null;
}

export interface LogRow {
	workspaceId: string;
	seq: number;
	stream: "stdout" | "stderr" | "runtime";
	occurredAt: Date;
	content: Uint8Array;
}

export interface WorkspaceListFilter {
	externalId?: string;
	state?: WorkspaceState;
	template?: string;
	limit: number;
	cursor?: string;
}

export interface ActiveCounts {
	global: number;
	byPrincipal: Record<string, number>;
	byTemplate: Record<string, number>;
}

export interface WorkspaceInsert {
	id: string;
	principalId: string;
	externalId: string;
	idempotencyKey: string;
	requestDigest: string;
	templateId: string;
	templateSnapshot: TemplateSnapshot;
	launchInput: Record<string, unknown> | null;
	metadata: Record<string, string>;
	deadlineAt: Date;
	createdAt: Date;
}

export type WorkspacePatch = Partial<
	Pick<
		WorkspaceRow,
		| "terminalIntent"
		| "launchInput"
		| "providerKind"
		| "providerRef"
		| "registrationDigest"
		| "registrationExpiresAt"
		| "reconnectDigest"
		| "connectionEpoch"
		| "connectedAt"
		| "disconnectedAt"
		| "readyAt"
		| "lastActivityAt"
		| "launchAttempts"
		| "health"
	>
>;

export interface TransitionRequest {
	from: readonly WorkspaceState[];
	to: WorkspaceState;
	reason?: ReasonCode | null;
	at: Date;
	patch?: WorkspacePatch;
}

export interface TemplateUpsert {
	name: string;
	version: string;
	digest: string;
	description: string | null;
	spec: TemplateSpec;
}

export interface UpsertResult {
	row: TemplateRow;
	created: boolean;
	// True when the (name, version) exists with different content. Immutable
	// versions make this a deployment error.
	conflict: boolean;
}

export interface Store {
	init(): Promise<void>;
	close(): Promise<void>;

	// Templates.
	upsertTemplate(input: TemplateUpsert): Promise<UpsertResult>;
	listTemplates(names: string[] | null): Promise<TemplateRow[]>;
	getTemplate(name: string, version?: string): Promise<TemplateRow | null>;
	setTemplateStatus(name: string, version: string, status: TemplateStatus): Promise<void>;

	// Principals and machine keys.
	createPrincipal(name: string, scopes: string[], templateNames: string[]): Promise<PrincipalRow>;
	getPrincipalByName(name: string): Promise<PrincipalRow | null>;
	listPrincipals(): Promise<PrincipalRow[]>;
	setPrincipalDisabled(id: string, disabled: boolean): Promise<void>;
	insertMachineKey(row: MachineKeyRow): Promise<void>;
	getMachineKeyWithPrincipal(
		keyId: string,
	): Promise<{ key: MachineKeyRow; principal: PrincipalRow } | null>;
	revokeMachineKey(keyId: string, at: Date): Promise<boolean>;
	touchMachineKey(keyId: string, at: Date): Promise<void>;

	// Workspaces.
	insertWorkspace(
		row: WorkspaceInsert,
	): Promise<{ workspace: WorkspaceRow; created: boolean; conflict: boolean }>;
	getWorkspace(id: string): Promise<WorkspaceRow | null>;
	listWorkspaces(principalId: string, filter: WorkspaceListFilter): Promise<WorkspaceRow[]>;
	listQueued(limit: number): Promise<WorkspaceRow[]>;
	listNonterminal(): Promise<WorkspaceRow[]>;
	countActive(): Promise<ActiveCounts>;
	countQueued(): Promise<number>;
	updateWorkspace(id: string, patch: WorkspacePatch, at: Date): Promise<void>;
	// Atomic guarded transition: succeeds only when the current state is in
	// `from`, appends state history and the outbox event in the same commit.
	transition(id: string, req: TransitionRequest): Promise<WorkspaceRow | null>;
	listStateHistory(workspaceId: string): Promise<StateHistoryRow[]>;

	// Logs.
	appendLogs(
		workspaceId: string,
		entries: Array<{ stream: LogRow["stream"]; occurredAt: Date; content: Uint8Array }>,
	): Promise<void>;
	readLogs(workspaceId: string, afterSeq: number, limit: number): Promise<LogRow[]>;

	// Outbox.
	claimDueEvents(now: Date, limit: number): Promise<OutboxRow[]>;
	markEventDelivered(id: string, at: Date): Promise<void>;
	markEventFailed(id: string, errorCode: string, nextAttemptAt: Date): Promise<void>;
}
