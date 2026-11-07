import type { ExecutionRecord } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "../types";
import type { ExecutionTransport } from "./execution-dispatcher";

export async function releaseUnsentExecution(
  record: ExecutionRecord,
  workspace: WorkspaceRow,
  transport: ExecutionTransport,
) {
  if (record.finalizationBasis !== "never_sent" || record.collection?.cleanupState !== "pending") return false;
  await transport.release?.(record, workspace);
  return true;
}
