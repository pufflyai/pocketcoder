// Runs admitted setup before harness dispatch; lifecycle closure remains the supervisor's owner.
import type { ExecSpec } from "@pstdio/pocketcoder-contracts";
import { EXIT_NETWORK_POLICY_FAILED, EXIT_SETUP_FAILED, EXIT_WRITABLE_MEMORY_FAILED } from "./supervisor-constants";
import {
  clearSourceCredential,
  preflightNetwork,
  probeWritableMemory,
  reportResolvedSource,
  runSetupWithCredentials,
} from "./supervisor-setup";

export async function prepareSupervisorWorkspace(
  exec: ExecSpec,
  callbacks: Parameters<typeof runSetupWithCredentials>[1],
): Promise<number | null> {
  if (!(await preflightNetwork(exec, callbacks.send, callbacks.signal))) {
    clearSourceCredential(exec);
    return EXIT_NETWORK_POLICY_FAILED;
  }

  if (exec.launch_mode === "restore") {
    callbacks.send("restore_status", {
      phase: "validating",
      capability: exec.persistence.conversation_restore,
    });
  }
  const memoryOk = await probeWritableMemory(exec, callbacks.log);
  if (!memoryOk) {
    clearSourceCredential(exec);
    callbacks.send("process_state", {
      phase: "exited",
      exit_code: EXIT_WRITABLE_MEMORY_FAILED,
      setup_step: "writable-memory-preflight",
    });
    return EXIT_WRITABLE_MEMORY_FAILED;
  }
  if (callbacks.isStopped()) return null;
  const failedSetupStep = await runSetupWithCredentials(exec, {
    send: callbacks.send,
    log: callbacks.log,
    pump: callbacks.pump,
    addSecret: callbacks.addSecret,
    removeSecret: callbacks.removeSecret,
    setSetupPhase: callbacks.setSetupPhase,
    setChild: callbacks.setChild,
    isStopped: callbacks.isStopped,
    signal: callbacks.signal,
  });
  if (failedSetupStep) {
    callbacks.send("process_state", {
      phase: "exited",
      exit_code: EXIT_SETUP_FAILED,
      setup_step: failedSetupStep,
    });
    return EXIT_SETUP_FAILED;
  }
  if (callbacks.isStopped()) return null;
  await reportResolvedSource(exec, callbacks.send, callbacks.log);
  if (exec.launch_mode === "restore") {
    callbacks.send("restore_status", {
      phase: "ready",
      capability: exec.persistence.conversation_restore,
    });
  }
  return null;
}
