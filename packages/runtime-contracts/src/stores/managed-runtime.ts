import type { managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionIdentity } from "./managed-sessions";
import type { ManagedCapacityStore, ManagedFileStore, ManagedRequestStore, ManagedStopResult } from "./managed-work";

export type {
  ManagedCancelRecord,
  ManagedCapacityIdentity,
  ManagedCapacityRecord,
  ManagedCapacityStore,
  ManagedFileStore,
  ManagedPlacementIntent,
  ManagedQueueLimits,
  ManagedRequestRecord,
  ManagedRequestStore,
  ManagedStopResult,
} from "./managed-work";

export interface ManagedBinding {
  workspaceId: string;
  incarnationId: string;
  generation: number;
}
export interface ManagedProfile extends managed.SessionProfile {
  templateDigest: string;
  businessSlots: string[];
}
export interface ManagedLeaseAuthority extends ManagedSessionIdentity {
  profile: string;
  owner: string;
  group: string;
  generation: number;
  incarnationId: string;
  slot: string;
  issuer: string;
}
export interface ManagedProfileStore {
  reconcile(
    principalId: string,
    profiles: Record<string, managed.ProfileConfig>,
    issuers: Record<string, managed.SessionIssuer>,
    dryRun?: boolean,
  ): Promise<{ profiles: string[]; issuers: string[]; unavailableProfiles: string[] }>;
  get(keyId: string, name: string): Promise<managed.SessionProfile>;
  issuer(principalId: string, name: string): Promise<managed.SessionIssuer>;
  leaseAuthority(
    identity: ManagedSessionIdentity,
    workspaceId: string,
    generation: number,
    slot: string,
  ): Promise<{ authority: ManagedLeaseAuthority; issuer: managed.SessionIssuer }>;
}
export interface ManagedSessionStore {
  create(keyId: string, input: managed.SessionCreate): Promise<managed.Session>;
  get(keyId: string, sessionId: string): Promise<managed.Session>;
  list(
    keyId: string,
    filters: { owner?: string; state?: "open" | managed.Session["state"] },
  ): Promise<(managed.Session & { activeRequestId: string | null })[]>;
  bind(identity: ManagedSessionIdentity, expectedRevision: number, binding: ManagedBinding | null): Promise<number>;
  appendObservation(
    identity: ManagedSessionIdentity,
    expectedRevision: number,
    state: managed.Session["state"],
    reasonCode: string | null,
  ): Promise<managed.Session>;
  close(keyId: string, sessionId: string, at: Date): Promise<ManagedStopResult>;
  cancel(keyId: string, sessionId: string, at: Date): Promise<ManagedStopResult>;
  // The current physical binding behind a logical session, after the caller's read authority is rechecked.
  binding(keyId: string, sessionId: string): Promise<(ManagedBinding & { bindingRevision: number }) | null>;
}
export interface ManagedRecoveryCandidate {
  id: ManagedSessionIdentity;
  session: managed.Session;
  binding: ManagedBinding | null;
  bindingRevision: number;
  lastGeneration: number;
  queueCount: number;
  placement: import("./managed-work").ManagedPlacementIntent | null;
  resumeRequested: boolean;
  templateDigest: string;
  closing: boolean;
  // Compute a closing session owns alone and must stop.
  ownedWorkspaceIds: string[];
  openRequests: number;
}
export interface ManagedRecoveryStore {
  candidates(): Promise<ManagedRecoveryCandidate[]>;
  resume(keyId: string, sessionId: string, at: Date): Promise<managed.Session>;
  recordPlacement(
    identity: ManagedSessionIdentity,
    intent: import("./managed-work").ManagedPlacementIntent,
  ): Promise<import("./managed-work").ManagedPlacementIntent>;
  failPlacement(identity: ManagedSessionIdentity, workspaceId: string): Promise<void>;
  placed(identity: ManagedSessionIdentity, workspaceId: string): Promise<void>;
  transition(
    identity: ManagedSessionIdentity,
    state: managed.Session["state"],
    reasonCode: string | null,
  ): Promise<managed.Session>;
}
export interface ManagedHistoryStore {
  snapshot(
    keyId: string,
    sessionId: string,
    after?: { records: number; events: number },
  ): Promise<{
    session: managed.Session;
    requests: managed.Request[];
    records: import("@pstdio/pocketcoder-contracts").ConversationRecordDocument[];
    eventCursor: string;
    binding: ManagedBinding | null;
    recordCursor: number;
    reset: boolean;
  }>;
  history(keyId: string, sessionId: string, cursor: string | null, limit: number): Promise<managed.HistoryPage>;
  events(keyId: string, sessionId: string, after: string | null, limit: number): Promise<managed.RuntimeEvent[]>;
  prune(keepEvents: number): Promise<number>;
}
export interface ManagedRuntimeStore {
  history: ManagedHistoryStore;
  recovery: ManagedRecoveryStore;
  profiles: ManagedProfileStore;
  sessions: ManagedSessionStore;
  requests: ManagedRequestStore;
  files: ManagedFileStore;
  capacity: ManagedCapacityStore;
}
