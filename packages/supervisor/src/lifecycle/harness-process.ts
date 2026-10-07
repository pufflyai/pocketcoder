// Starts the actual harness and joins both original output streams after its child closes.
import type { ExecSpec, ProviderInput } from "@pstdio/pocketcoder-contracts";
import { enforcedEnvironment } from "../bootstrap/supervisor-utils";
import type { SupervisorLogs } from "../observability/supervisor-logs";

export function startSupervisorHarness(exec: ExecSpec, input: ProviderInput, logs: SupervisorLogs) {
  const child = Bun.spawn(exec.harness.command, {
    cwd: exec.harness.cwd ?? "/",
    env: enforcedEnvironment(exec, {
      ...exec.harness.env,
      POCKETCODER_LAUNCH_MODE: exec.launch_mode,
      ...(exec.source ? { POCKETCODER_SOURCE: JSON.stringify(exec.source) } : {}),
      ...(exec.restore ? { POCKETCODER_RESTORE: JSON.stringify(exec.restore) } : {}),
      ...(input.launch_input ? { POCKETCODER_LAUNCH_INPUT: JSON.stringify(input.launch_input) } : {}),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const pumps = [logs.pump(child.stdout, "stdout"), logs.pump(child.stderr, "stderr")];
  const completion = (async () => {
    const code = await child.exited;
    await Promise.all(pumps);
    return code;
  })();
  return { child, completion };
}
