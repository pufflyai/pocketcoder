import type { AgentFrame, ExecSpec } from "@pstdio/pocketcoder-contracts";
import type { SupervisorTransfers } from "../agent/supervisor-transfers";
import type { SupervisorLogs } from "../observability/supervisor-logs";
import { EXIT_SETUP_FAILED } from "./supervisor-constants";
import { clearSourceCredential } from "./supervisor-setup";

export async function installRestoredCheckpoint(
  exec: ExecSpec,
  transfers: SupervisorTransfers,
  callbacks: {
    send(type: AgentFrame["type"], payload: unknown): boolean;
    close(): Promise<void>;
    logs: Pick<SupervisorLogs, "log" | "addSecret" | "removeSecret">;
  },
) {
  if (exec.launch_mode !== "restore") return true;
  callbacks.send("restore_status", { phase: "validating", capability: exec.persistence.conversation_restore });
  const credential = exec.restore?.transfer?.credential;
  if (credential) callbacks.logs.addSecret(credential);
  try {
    if (exec.restore?.mode === "provider_installed") return true;
    if (!exec.restore?.transfer) throw new Error("Restore grant is missing.");
    if (
      exec.restore.transfer.checkpoint_id !== exec.restore.checkpoint_id ||
      exec.restore.transfer.source.workspace_id !== exec.restore.origin_workspace_id
    )
      throw new Error("Restore grant source differs from workspace lineage.");
    await transfers.restore(exec.restore.transfer, exec);
    exec.restore.transfer = null;
    return true;
  } catch (error) {
    callbacks.logs.log(
      `Checkpoint installation failed: ${error instanceof Error ? error.message : "verification failed"}`,
    );
    callbacks.send("process_state", {
      phase: "exited",
      exit_code: EXIT_SETUP_FAILED,
      setup_step: "checkpoint-installation",
    });
    clearSourceCredential(exec);
    await callbacks.close();
    return false;
  } finally {
    if (credential) callbacks.logs.removeSecret(credential);
    if (exec.restore?.transfer) exec.restore.transfer.credential = "";
  }
}

export function reportRestoreReady(exec: ExecSpec, send: (type: AgentFrame["type"], payload: unknown) => boolean) {
  if (exec.launch_mode === "restore")
    send("restore_status", { phase: "ready", capability: exec.persistence.conversation_restore });
}
