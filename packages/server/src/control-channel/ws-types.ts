import type { CheckpointInstalled, ProtocolVersion, RestoreTransferSpec } from "@pstdio/pocketcoder-contracts";
import type { Scheduler, Store, WorkspaceRow, WorkspaceSecretResolver } from "@pstdio/pocketcoder-runtime-core";
import type { WSContext } from "hono/ws";
import type { PersistenceService } from "../persistence/persistence";
import type { Hub, LiveConnection } from "./hub";

export interface WsDeps {
  store: Store;
  hub: Hub;
  scheduler: Scheduler;
  pepper: string;
  secretResolver?: WorkspaceSecretResolver;
  cleanupInput?: (workspaceId: string) => Promise<void>;
  log?: (msg: string) => void;
  persistence?: PersistenceService;
  checkpointTransfers?: CheckpointTransferService;
}

export interface WsAuth {
  workspaceId: string;
  mode: "register" | "reconnect";
  protocolVersion: ProtocolVersion;
}

export type CloseProtocol = (ws: WSContext, message: string) => void;

export interface CheckpointTransferService {
  restoreGrant(connection: LiveConnection, row: WorkspaceRow): Promise<RestoreTransferSpec | null>;
  installed(connection: LiveConnection, payload: CheckpointInstalled): Promise<boolean>;
  ready(connection: LiveConnection): Promise<boolean>;
  disconnected?(connection: LiveConnection): Promise<void>;
}
