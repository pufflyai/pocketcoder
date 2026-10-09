import type { AgentFrame, ExecSpec, ProviderInput } from "@pstdio/pocketcoder-contracts";
import { EXIT_SETUP_FAILED } from "../bootstrap/supervisor-constants";
import { reportRestoreReady } from "../bootstrap/supervisor-restore";
import { enforcedEnvironment } from "../bootstrap/supervisor-utils";
import type { SupervisorLogs } from "../observability/supervisor-logs";

type ChildPhase = "starting" | "setup" | "running" | "exited" | "terminating";

export function createSupervisorHarness(
  input: ProviderInput,
  callbacks: {
    send(type: AgentFrame["type"], payload: unknown): boolean;
    logs: Pick<SupervisorLogs, "log" | "pump">;
    close(): Promise<void>;
    isQuiesced(): boolean;
    exit(code: number): void;
  },
) {
  const harness = {
    child: null as ReturnType<typeof spawnHarness> | null,
    phase: "starting" as ChildPhase,
    exitCode: null as number | null,
    drained: Promise.resolve(),
    start(exec: ExecSpec) {
      return startHarness(exec, input, {
        ...callbacks,
        retain: (child, drained) => {
          harness.child = child;
          harness.drained = drained;
          harness.phase = "running";
        },
        exited: async (code) => {
          harness.phase = "exited";
          harness.exitCode = code;
          callbacks.send("process_state", { phase: "exited", exit_code: code });
          if (callbacks.isQuiesced()) return;
          await callbacks.close();
          callbacks.exit(code);
        },
      });
    },
  };
  return harness;
}

export function spawnHarness(exec: ExecSpec, input: ProviderInput) {
  // The caller's opaque launch input reaches the harness in memory
  // only; it is never written to the workspace filesystem by the
  // supervisor and the server erases its copy at readiness.
  return Bun.spawn(exec.harness.command, {
    cwd: exec.harness.cwd ?? "/",
    env: enforcedEnvironment(exec, {
      ...exec.harness.env,
      POCKETCODER_LAUNCH_MODE: exec.launch_mode,
      ...(exec.source ? { POCKETCODER_SOURCE: JSON.stringify(exec.source) } : {}),
      ...(exec.restore
        ? {
            POCKETCODER_RESTORE: JSON.stringify({
              checkpoint_id: exec.restore.checkpoint_id,
              origin_workspace_id: exec.restore.origin_workspace_id,
            }),
          }
        : {}),
      ...(input.launch_input ? { POCKETCODER_LAUNCH_INPUT: JSON.stringify(input.launch_input) } : {}),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function startHarness(
  exec: ExecSpec,
  input: ProviderInput,
  callbacks: {
    retain(child: ReturnType<typeof spawnHarness>, drained: Promise<void>): void;
    exited(code: number): Promise<void>;
    send(type: AgentFrame["type"], payload: unknown): boolean;
    logs: Pick<SupervisorLogs, "log" | "pump">;
    close(): Promise<void>;
  },
) {
  let child: ReturnType<typeof spawnHarness>;
  try {
    child = spawnHarness(exec, input);
  } catch (error) {
    callbacks.logs.log(`Harness start failed: ${error instanceof Error ? error.message : "spawn failed"}`);
    callbacks.send("process_state", { phase: "exited", exit_code: EXIT_SETUP_FAILED, setup_step: "harness-start" });
    await callbacks.close();
    return false;
  }
  const pumps = [callbacks.logs.pump(child.stdout, "stdout"), callbacks.logs.pump(child.stderr, "stderr")];
  const drained = child.exited.then(async (code) => {
    await Promise.all(pumps);
    await callbacks.exited(code);
  });
  // Readiness frames are evidence of an owned child, so retain it before sending them.
  callbacks.retain(child, drained);
  callbacks.send("process_state", { phase: "running" });
  reportRestoreReady(exec, callbacks.send);
  return true;
}
