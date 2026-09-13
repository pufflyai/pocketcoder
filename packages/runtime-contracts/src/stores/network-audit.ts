import type { NetworkEventInput } from "@pstdio/pocketcoder-contracts";

export interface NetworkEventRow extends NetworkEventInput {
  workspaceId: string;
  seq: number;
  sourceSessionId: string;
}

export interface NetworkAuditStore {
  appendNetworkEvents(workspaceId: string, sourceSessionId: string, events: NetworkEventInput[]): Promise<void>;
  readNetworkEvents(workspaceId: string, afterSeq: number, limit: number): Promise<NetworkEventRow[]>;
}
