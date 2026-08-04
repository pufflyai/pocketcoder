import type {
	AgentState,
	CheckpointManifest,
	CheckpointState,
	ConversationRestoreCapability,
	ConversationRole,
	LaunchMode,
	NetworkEventInput,
	NetworkState,
	OperationKind,
	OperationState,
	PersistenceMount,
	ReasonCode,
	ResolvedSource,
	SourceDescriptor,
	StorageState,
	TemplateSnapshot,
	TemplateSpec,
	WorkspaceState,
} from "@pstdio/pocketcoder-contracts";

// Driver-neutral durable and in-memory adapter contracts.

export const TEMPLATE_STATUSES = ["active", "available", "retired"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

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
	// Empty means inherit the principal's live scopes; non-empty narrows them.
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
	agentState: AgentState;
	networkState: NetworkState;
	networkEventSeq: number;
	changeSeq: number;
	failureLogTail: string | null;
	failureLogTailTruncated: boolean;
	failureLastLogSeq: number | null;
	// Desired terminal state while `terminating` (e.g. canceled vs expired).
	terminalIntent: WorkspaceState | null;
	launchInput: Record<string, unknown> | null;
	providerKind: string | null;
	providerRef: Record<string, unknown> | null;
	provisioningMode: "cold" | "warm" | null;
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
	originWorkspaceId: string | null;
	restoredFromCheckpointId: string | null;
	sourceDescriptor: SourceDescriptor | null;
	resolvedSource: ResolvedSource | null;
	persistenceCapability: ConversationRestoreCapability;
	latestCheckpointId: string | null;
	launchMode: LaunchMode;
	outputs: Record<string, unknown>;
}

export interface WorkspaceStorageRow {
	id: string;
	workspaceId: string;
	principalId: string;
	providerKind: string;
	providerRef: Record<string, unknown>;
	state: StorageState;
	mountManifest: PersistenceMount[];
	logicalBytes: number | null;
	fileCount: number | null;
	retainedUntil: Date | null;
	createdAt: Date;
	updatedAt: Date;
	deletedAt: Date | null;
	lastErrorCode: string | null;
}

export interface WorkspaceCheckpointRow {
	id: string;
	workspaceId: string;
	principalId: string;
	storageId: string;
	parentCheckpointId: string | null;
	state: CheckpointState;
	reasonCode: string | null;
	providerKind: string;
	providerRef: Record<string, unknown> | null;
	templateSnapshot: TemplateSnapshot;
	templateDigest: string;
	sourceProvenance: ResolvedSource | null;
	manifest: CheckpointManifest | null;
	manifestDigest: string | null;
	logicalBytes: number | null;
	storedBytes: number | null;
	fileCount: number | null;
	conversationRestore: ConversationRestoreCapability;
	label: string | null;
	createdAt: Date;
	updatedAt: Date;
	readyAt: Date | null;
	expiresAt: Date | null;
	deletedAt: Date | null;
}

export interface WorkspaceOperationRow {
	id: string;
	principalId: string;
	kind: OperationKind;
	state: OperationState;
	idempotencyKey: string;
	requestDigest: string;
	workspaceId: string | null;
	checkpointId: string | null;
	resultWorkspaceId: string | null;
	reasonCode: string | null;
	attemptCount: number;
	createdAt: Date;
	updatedAt: Date;
	completedAt: Date | null;
}

export class OperationCapacityExceededError extends Error {
	constructor() {
		super("persistence operation capacity exceeded");
	}
}

export interface WorkspaceOutputRow {
	workspaceId: string;
	seq: number;
	name: string;
	value: unknown;
	occurredAt: Date;
}

export interface NetworkEventRow extends NetworkEventInput {
	workspaceId: string;
	seq: number;
	sourceSessionId: string;
}

export const WARM_POOL_RUNTIME_STATES = [
	"provisioning",
	"ready",
	"leasing",
	"leased",
	"draining",
	"failed",
] as const;
export type WarmPoolRuntimeState = (typeof WARM_POOL_RUNTIME_STATES)[number];

export interface WarmPoolRuntimeRow {
	id: string;
	templateId: string;
	templateName: string;
	templateVersion: string;
	templateDigest: string;
	driverKind: string;
	eligibilityFingerprint: string;
	state: WarmPoolRuntimeState;
	providerRef: Record<string, unknown> | null;
	enrollmentDigest: Uint8Array | null;
	enrollmentExpiresAt: Date | null;
	workspaceId: string | null;
	createdAt: Date;
	updatedAt: Date;
	readyAt: Date | null;
	leasedAt: Date | null;
	failureCode: string | null;
}

export type WarmPoolRuntimePatch = Partial<
	Pick<
		WarmPoolRuntimeRow,
		| "state"
		| "providerRef"
		| "enrollmentDigest"
		| "enrollmentExpiresAt"
		| "workspaceId"
		| "readyAt"
		| "leasedAt"
		| "failureCode"
	>
>;

export interface WarmPoolClaim {
	workspaceId: string;
	templateDigest: string;
	driverKind: string;
	eligibilityFingerprint: string;
	registrationDigest: Uint8Array;
	registrationExpiresAt: Date;
	at: Date;
}

export interface CheckpointUsage {
	count: number;
	logicalBytes: number;
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

export interface ConversationMessageRow {
	workspaceId: string;
	seq: number;
	messageId: string;
	role: ConversationRole;
	content: string;
	occurredAt: Date;
	metadata: Record<string, string>;
	createdAt: Date;
}

export interface ConversationStateRow {
	workspaceId: string;
	status: "retained" | "deleted";
	expiresAt: Date | null;
	deletedAt: Date | null;
	updatedAt: Date;
}

export interface WorkspaceListFilter {
	externalId?: string;
	state?: WorkspaceState;
	template?: string;
	metadata?: Record<string, string>;
	createdAfter?: Date;
	createdBefore?: Date;
	limit: number;
	cursor?: string;
}

export interface ActiveCounts {
	global: number;
	byPrincipal: Record<string, number>;
	byTemplate: Record<string, number>;
}

export interface WorkspaceAdmissionClaim {
	workspaceId: string;
	at: Date;
	registrationDigest: Uint8Array;
	registrationExpiresAt: Date;
	limits: {
		globalActiveWorkspaces: number;
		perPrincipalActiveWorkspaces: number;
		perTemplateActiveWorkspaces: Record<string, number>;
	};
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
	originWorkspaceId?: string | null;
	restoredFromCheckpointId?: string | null;
	sourceDescriptor?: SourceDescriptor | null;
	resolvedSource?: ResolvedSource | null;
	persistenceCapability?: ConversationRestoreCapability;
	latestCheckpointId?: string | null;
	launchMode?: LaunchMode;
	outputs?: Record<string, unknown>;
}

export type WorkspaceInsertResult =
	| { kind: "created" | "replayed"; workspace: WorkspaceRow }
	| {
			kind: "conflict";
			conflict: "idempotency" | "external_id";
			workspace: WorkspaceRow;
	  }
	| { kind: "capacity_exceeded" };

export type WorkspacePatch = Partial<
	Pick<
		WorkspaceRow,
		| "terminalIntent"
		| "launchInput"
		| "providerKind"
		| "providerRef"
		| "provisioningMode"
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
		| "agentState"
		| "networkState"
		| "failureLogTail"
		| "failureLogTailTruncated"
		| "failureLastLogSeq"
		| "resolvedSource"
		| "persistenceCapability"
		| "latestCheckpointId"
		| "outputs"
	>
>;

export type WorkspaceStoragePatch = Partial<
	Pick<
		WorkspaceStorageRow,
		| "providerKind"
		| "providerRef"
		| "state"
		| "logicalBytes"
		| "fileCount"
		| "retainedUntil"
		| "deletedAt"
		| "lastErrorCode"
	>
>;

export type WorkspaceCheckpointPatch = Partial<
	Pick<
		WorkspaceCheckpointRow,
		| "state"
		| "reasonCode"
		| "providerKind"
		| "providerRef"
		| "manifest"
		| "manifestDigest"
		| "logicalBytes"
		| "storedBytes"
		| "fileCount"
		| "conversationRestore"
		| "readyAt"
		| "expiresAt"
		| "deletedAt"
	>
>;

export type WorkspaceOperationPatch = Partial<
	Pick<
		WorkspaceOperationRow,
		"state" | "checkpointId" | "resultWorkspaceId" | "reasonCode" | "attemptCount" | "completedAt"
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

export interface StoreLifecycle {
	init(): Promise<void>;
	acquireCoordinatorLease(): Promise<() => Promise<void>>;
	close(): Promise<void>;
}

export interface TemplateStore {
	upsertTemplate(input: TemplateUpsert): Promise<UpsertResult>;
	listTemplates(names: string[] | null): Promise<TemplateRow[]>;
	getTemplate(name: string, version?: string): Promise<TemplateRow | null>;
	setTemplateStatus(name: string, version: string, status: TemplateStatus): Promise<void>;
}

export interface WarmPoolStore {
	insertWarmPoolRuntime(row: WarmPoolRuntimeRow): Promise<WarmPoolRuntimeRow>;
	getWarmPoolRuntime(id: string): Promise<WarmPoolRuntimeRow | null>;
	listWarmPoolRuntimes(): Promise<WarmPoolRuntimeRow[]>;
	updateWarmPoolRuntime(id: string, patch: WarmPoolRuntimePatch, at: Date): Promise<void>;
	claimWarmPoolRuntime(
		claim: WarmPoolClaim,
	): Promise<{ runtime: WarmPoolRuntimeRow; workspace: WorkspaceRow } | null>;
}

export interface AuthStore {
	createPrincipal(name: string, scopes: string[], templateNames: string[]): Promise<PrincipalRow>;
	getPrincipalByName(name: string): Promise<PrincipalRow | null>;
	listPrincipals(): Promise<PrincipalRow[]>;
	updatePrincipal(
		id: string,
		scopes: string[],
		templateNames: string[],
	): Promise<PrincipalRow | null>;
	setPrincipalDisabled(id: string, disabled: boolean): Promise<void>;
	insertMachineKey(row: MachineKeyRow): Promise<void>;
	getMachineKeyWithPrincipal(
		keyId: string,
	): Promise<{ key: MachineKeyRow; principal: PrincipalRow } | null>;
	revokeMachineKey(keyId: string, at: Date): Promise<boolean>;
	touchMachineKey(keyId: string, at: Date): Promise<void>;
}

export interface WorkspaceStore {
	insertWorkspace(
		row: WorkspaceInsert,
		options?: { maxQueuedWorkspaces?: number },
	): Promise<WorkspaceInsertResult>;
	getWorkspaceByIdempotency(
		principalId: string,
		idempotencyKey: string,
	): Promise<WorkspaceRow | null>;
	getWorkspace(id: string): Promise<WorkspaceRow | null>;
	listWorkspaces(principalId: string, filter: WorkspaceListFilter): Promise<WorkspaceRow[]>;
	listQueuedHeads(): Promise<WorkspaceRow[]>;
	listNonterminal(): Promise<WorkspaceRow[]>;
	countActive(): Promise<ActiveCounts>;
	countQueued(): Promise<number>;
	claimWorkspaceAdmission(claim: WorkspaceAdmissionClaim): Promise<WorkspaceRow | null>;
	updateWorkspace(id: string, patch: WorkspacePatch, at: Date): Promise<void>;
	waitForWorkspaceChange(
		id: string,
		afterSeq: number,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void>;
	// Atomic guarded transition: succeeds only when the current state is in
	// `from`, appends state history and the outbox event in the same commit.
	transition(id: string, req: TransitionRequest): Promise<WorkspaceRow | null>;
	listStateHistory(workspaceId: string): Promise<StateHistoryRow[]>;
}

export interface PersistenceStore {
	insertWorkspaceStorage(row: WorkspaceStorageRow): Promise<WorkspaceStorageRow>;
	getWorkspaceStorage(workspaceId: string): Promise<WorkspaceStorageRow | null>;
	getStorage(id: string): Promise<WorkspaceStorageRow | null>;
	updateWorkspaceStorage(id: string, patch: WorkspaceStoragePatch, at: Date): Promise<void>;
	insertCheckpoint(row: WorkspaceCheckpointRow): Promise<WorkspaceCheckpointRow>;
	getCheckpoint(id: string): Promise<WorkspaceCheckpointRow | null>;
	listCheckpoints(
		principalId: string,
		filter?: { workspaceId?: string; state?: CheckpointState },
	): Promise<WorkspaceCheckpointRow[]>;
	updateCheckpoint(id: string, patch: WorkspaceCheckpointPatch, at: Date): Promise<void>;
	insertOperation(
		row: WorkspaceOperationRow,
		options?: { maxIncompleteOperations?: number },
	): Promise<{ operation: WorkspaceOperationRow; created: boolean; conflict: boolean }>;
	getOperation(id: string): Promise<WorkspaceOperationRow | null>;
	getOperationByIdempotency(
		principalId: string,
		kind: OperationKind,
		idempotencyKey: string,
	): Promise<WorkspaceOperationRow | null>;
	listIncompleteOperations(): Promise<WorkspaceOperationRow[]>;
	updateOperation(id: string, patch: WorkspaceOperationPatch, at: Date): Promise<void>;
	checkpointUsage(principalId: string | null): Promise<CheckpointUsage>;
	countIncompleteOperations(): Promise<number>;
}

export interface OutputStore {
	appendOutput(row: WorkspaceOutputRow): Promise<WorkspaceOutputRow>;
	listOutputs(workspaceId: string): Promise<WorkspaceOutputRow[]>;
}

export interface LogStore {
	appendLogs(
		workspaceId: string,
		entries: Array<{ stream: LogRow["stream"]; occurredAt: Date; content: Uint8Array }>,
	): Promise<void>;
	readLogs(workspaceId: string, afterSeq: number, limit: number): Promise<LogRow[]>;
	readLogTail(
		workspaceId: string,
		maxBytes: number,
	): Promise<{ content: Uint8Array; truncated: boolean; lastSeq: number | null }>;
}

export interface NetworkAuditStore {
	appendNetworkEvents(
		workspaceId: string,
		sourceSessionId: string,
		events: NetworkEventInput[],
	): Promise<void>;
	readNetworkEvents(
		workspaceId: string,
		afterSeq: number,
		limit: number,
	): Promise<NetworkEventRow[]>;
}

export interface ConversationStore {
	appendConversationMessage(
		row: Omit<ConversationMessageRow, "seq">,
	): Promise<{ message: ConversationMessageRow; created: boolean }>;
	readConversation(
		workspaceId: string,
		afterSeq: number,
		limit: number,
	): Promise<ConversationMessageRow[]>;
	getConversationState(workspaceId: string): Promise<ConversationStateRow | null>;
	setConversationExpiry(workspaceId: string, expiresAt: Date, at: Date): Promise<void>;
	deleteConversation(workspaceId: string, at: Date): Promise<void>;
	pruneExpiredConversations(at: Date): Promise<number>;
}

export interface OutboxStore {
	claimDueEvents(now: Date, limit: number): Promise<OutboxRow[]>;
	markEventDelivered(id: string, at: Date): Promise<void>;
	markEventFailed(id: string, errorCode: string, nextAttemptAt: Date): Promise<void>;
	appendEvent(workspaceId: string, eventType: string, payload: unknown, at: Date): Promise<void>;
}

// Composition roots and complete adapters use the aggregate. Application
// services depend on the smallest capability intersection they need.
export interface Store
	extends StoreLifecycle,
		TemplateStore,
		WarmPoolStore,
		AuthStore,
		WorkspaceStore,
		PersistenceStore,
		OutputStore,
		LogStore,
		NetworkAuditStore,
		ConversationStore,
		OutboxStore {}
