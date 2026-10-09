import type { TerminalClosed, TerminalCloseReason } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { TerminalBridgeCallbacks } from "./terminal-bridge";

function terminalAuditReason(reason: TerminalClosed["reason"]): TerminalCloseReason {
  if (reason === "error") return "agent_detached";
  if (reason === "closed") return "client_closed";
  return reason;
}

export function terminalCallbacks(store: Store): TerminalBridgeCallbacks {
  return {
    onTerminalInput: (workspaceId) => {
      const now = new Date();
      return store.updateWorkspace(workspaceId, { lastActivityAt: now }, now);
    },
    onTerminalClosed: async (event) => {
      const closedAt = new Date();
      const closeReason = terminalAuditReason(event.reason);
      const session = await store.closeTerminalSession(event.session_id, {
        closedAt,
        closeReason,
        exitCode: event.exit_code ?? null,
        bytesIn: event.bytesIn,
        bytesOut: event.bytesOut,
      });
      if (!session) return;
      await store.appendEvent(
        event.workspaceId,
        "workspace.terminal_closed",
        {
          session_id: session.sessionId,
          close_reason: session.closeReason,
          exit_code: session.exitCode,
          duration_ms: closedAt.getTime() - session.openedAt.getTime(),
          bytes_in: session.bytesIn,
          bytes_out: session.bytesOut,
        },
        closedAt,
      );
    },
  };
}
