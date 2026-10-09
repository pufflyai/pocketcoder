import type { ExecSpec } from "@pstdio/pocketcoder-contracts";
import type { SupervisorTransfers } from "../agent/supervisor-transfers";
import type { SupervisorLogs } from "../observability/supervisor-logs";
import type { SetupCompletion } from "./setup-completion";
import { prepareSourceSetup } from "./source-setup";
import { EXIT_SETUP_FAILED, EXIT_WRITABLE_MEMORY_FAILED } from "./supervisor-constants";
import { installRestoredCheckpoint } from "./supervisor-restore";
import { clearSourceCredential, probeWritableMemory } from "./supervisor-setup";

export async function prepareWorkspace(
  exec: ExecSpec,
  transfers: SupervisorTransfers,
  completion: SetupCompletion,
  callbacks: {
    send: Parameters<typeof prepareSourceSetup>[2]["send"];
    close(): Promise<void>;
    logs: SupervisorLogs;
    abort: AbortController;
    setSetupPhase(): void;
  },
) {
  const installed = await installRestoredCheckpoint(exec, transfers, callbacks);
  if (!installed) return EXIT_SETUP_FAILED;
  if (!(await probeWritableMemory(exec, callbacks.logs.log.bind(callbacks.logs)))) {
    clearSourceCredential(exec);
    callbacks.send("process_state", {
      phase: "exited",
      exit_code: EXIT_WRITABLE_MEMORY_FAILED,
      setup_step: "writable-memory-preflight",
    });
    await callbacks.close();
    return EXIT_WRITABLE_MEMORY_FAILED;
  }
  const failed = await prepareSourceSetup(exec, completion, {
    abort: callbacks.abort,
    send: callbacks.send,
    setSetupPhase: callbacks.setSetupPhase,
    log: callbacks.logs.log.bind(callbacks.logs),
    pump: callbacks.logs.pump.bind(callbacks.logs),
    addSecret: callbacks.logs.addSecret.bind(callbacks.logs),
    removeSecret: callbacks.logs.removeSecret.bind(callbacks.logs),
  });
  if (!failed) return null;
  callbacks.send("process_state", { phase: "exited", exit_code: EXIT_SETUP_FAILED, setup_step: failed });
  await callbacks.close();
  return EXIT_SETUP_FAILED;
}
