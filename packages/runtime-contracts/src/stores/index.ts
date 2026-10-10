import type { AuthStore } from "./auth";
import type { ConversationStore } from "./conversations";
import type { WorkspaceLeaseStore } from "./leases";
import type { StoreLifecycle } from "./lifecycle";
import type { LogStore } from "./logs";
import type { NetworkAuditStore } from "./network-audit";
import type { OutboxStore } from "./outbox";
import type { OutputStore } from "./outputs";
import type { PersistenceStore } from "./persistence";
import type { SecretStore } from "./secrets";
import type { TemplateStore } from "./templates";
import type { TerminalAuditStore } from "./terminals";
import type { WarmPoolStore } from "./warm-pools";
import type { WorkspaceStore } from "./workspaces";

// Composition roots and complete adapters use the aggregate. Application
// services depend on the smallest capability intersection they need.
export interface Store
  extends StoreLifecycle,
    TemplateStore,
    SecretStore,
    WorkspaceLeaseStore,
    WarmPoolStore,
    AuthStore,
    WorkspaceStore,
    PersistenceStore,
    OutputStore,
    LogStore,
    NetworkAuditStore,
    ConversationStore,
    TerminalAuditStore,
    OutboxStore {
  checkpointTransfers: import("./checkpoint-transfers").CheckpointTransferStore;
  binaryOutputs: import("./binary-outputs").BinaryOutputStore;
  storageReservations: import("./storage-reservations").StorageReservationStore;
}

export * from "./auth";
export * from "./checkpoint-transfers";
export * from "./conversations";
export * from "./leases";
export * from "./lifecycle";
export * from "./logs";
export * from "./network-audit";
export * from "./outbox";
export * from "./outputs";
export * from "./persistence";
export * from "./secrets";
export * from "./storage-reservations";
export * from "./templates";
export * from "./terminals";
export * from "./warm-pools";
export * from "./workspaces";
