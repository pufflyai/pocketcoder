import type { ProtocolVersion } from "@pstdio/pocketcoder-contracts";
import type { Scheduler, Store, WorkspaceSecretResolver } from "@pstdio/pocketcoder-runtime-core";
import type { WSContext } from "hono/ws";
import type { Hub } from "./hub";
import type { PersistenceService } from "./persistence";

export interface WsDeps {
  store: Store;
  hub: Hub;
  scheduler: Scheduler;
  pepper: string;
  secretResolver?: WorkspaceSecretResolver;
  cleanupInput?: (workspaceId: string) => Promise<void>;
  log?: (msg: string) => void;
  persistence?: PersistenceService;
}

export interface WsAuth {
  workspaceId: string;
  mode: "register" | "reconnect";
  protocolVersion: ProtocolVersion;
}

export type CloseProtocol = (ws: WSContext, message: string) => void;
