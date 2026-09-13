import type { AuthStore } from "./auth";
import type { ConversationStore } from "./conversations";
import type { StoreLifecycle } from "./lifecycle";
import type { LogStore } from "./logs";
import type { NetworkAuditStore } from "./network-audit";
import type { OutboxStore } from "./outbox";
import type { OutputStore } from "./outputs";
import type { PersistenceStore } from "./persistence";
import type { TemplateStore } from "./templates";
import type { TerminalAuditStore } from "./terminals";
import type { WarmPoolStore } from "./warm-pools";
import type { WorkspaceStore } from "./workspaces";

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
    TerminalAuditStore,
    OutboxStore {}

export * from "./auth";
export * from "./conversations";
export * from "./lifecycle";
export * from "./logs";
export * from "./network-audit";
export * from "./outbox";
export * from "./outputs";
export * from "./persistence";
export * from "./templates";
export * from "./terminals";
export * from "./warm-pools";
export * from "./workspaces";
