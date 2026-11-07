import type { ConversationRecordDocument, ConversationRequestIdentity, managed } from "@pstdio/pocketcoder-contracts";

// Principal is derived from authentication, never from the public request body.
export interface ManagedSessionIdentity {
  principalId: string;
  sessionId: string;
}
export interface ManagedRequestIdentity extends ManagedSessionIdentity {
  requestId: string;
}
export interface ManagedProfileAuthority {
  principalId: string;
  profile: managed.ExecutionProfile;
  authorizedAt: Date;
}
export interface ManagedPhysicalBinding {
  workspaceId: string;
  incarnationId: string;
  revision: number;
  conversation: ConversationRequestIdentity;
  // Physical request IDs use the server turn ID; public request IDs stay session-scoped.
  physicalRequestId: string;
  placement: ReturnType<typeof managed.managedPlacement>;
}

// PC-164/165/166 implement these on the existing conversation/input owners.
// The same transaction must cover authority checks, pins, queue charges and events.
export interface ManagedSessionPorts<Tx> {
  transaction<T>(run: (tx: Tx) => Promise<T>): Promise<T>;
  authorize(tx: Tx, identity: ManagedSessionIdentity, keyId: string): Promise<ManagedProfileAuthority>;
  session(tx: Tx, identity: ManagedSessionIdentity, lock: boolean): Promise<managed.Session | null>;
  create(tx: Tx, authority: ManagedProfileAuthority, input: managed.SessionCreate): Promise<managed.Session>;
  pinInputs(tx: Tx, identity: ManagedSessionIdentity, references: managed.InputReference[]): Promise<void>;
  accept(
    tx: Tx,
    identity: ManagedSessionIdentity,
    input: managed.RequestInput,
  ): Promise<{ replayed: boolean; request: managed.Request }>;
  request(tx: Tx, identity: ManagedRequestIdentity): Promise<managed.Request | null>;
  cancel(tx: Tx, identity: ManagedRequestIdentity, command: managed.CancelCommand): Promise<managed.CancelReceipt>;
  close(tx: Tx, identity: ManagedSessionIdentity, command: managed.CancelCommand): Promise<managed.CancelReceipt>;
  bind(tx: Tx, identity: ManagedRequestIdentity, binding: ManagedPhysicalBinding): Promise<void>;
  commitTerminal(
    tx: Tx,
    identity: ManagedRequestIdentity,
    request: managed.Request,
    record: ConversationRecordDocument,
  ): Promise<void>;
  commitCollection(tx: Tx, identity: ManagedRequestIdentity, collection: managed.CollectionResult): Promise<void>;
  // Implemented with the session lock, revision allocation and retained observations.
  appendEvent(tx: Tx, identity: ManagedSessionIdentity, event: managed.RuntimeEvent): Promise<void>;
  history(
    identity: ManagedSessionIdentity,
    cursor: string | null,
    limit: number,
  ): Promise<{ records: ConversationRecordDocument[]; nextCursor: string | null; eventCursor: string }>;
}
