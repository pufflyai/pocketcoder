import type { ProtocolVersion, ProxyResponse } from "@pstdio/pocketcoder-contracts";
import type { WSContext } from "hono/ws";
import type { RelayStreamChannel } from "../relay/relay-stream-channel";
import type { AttachmentChannel } from "./hub-attachments";

export interface LiveConnection {
  workspaceId: string;
  connectionId: string;
  epoch: number;
  ws: WSContext;
  lastSeqIn: number;
  seqOut: number;
  inflight: Map<string, PendingRelay>;
  streams: Map<string, RelayStreamChannel>;
  registered: boolean;
  restoreInstalled: boolean;
  harnessRunning: boolean;
  protocolVersion: ProtocolVersion;
  checkpoints: Map<string, PendingCheckpoint>;
  attachments: Map<string, AttachmentChannel>;
}

export interface PendingRelay {
  resolve: (res: ProxyResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PendingCheckpoint {
  resolve: (quiesced: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}
