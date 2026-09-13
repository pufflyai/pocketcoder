// Runs `pcd doctor` against a live stack. Doctor creates its own probe
// workspace, correlates a request and response through the relay, and cancels
// the workspace, so it exercises the operator path end to end.

export interface DoctorCheckOptions {
  baseUrl: string;
  key: string;
  template: string;
  turnTimeoutSeconds?: number;
}

export type DoctorRunner = (args: string[], env: Record<string, string>) => Promise<{ stdout: string }>;

// Doctor budgets this separately for input readiness and for the reply, so it
// bounds each half of the probe rather than the whole run.
const DEFAULT_TURN_TIMEOUT_SECONDS = 120;

export function piStartupCommand(command: string[]) {
  // Keep real AgentAPI busy past the first health probe on fast CI hosts.
  // Pi then starts normally, so readiness still comes from AgentAPI.
  return [
    "/bin/sh",
    "-c",
    'for attempt in 1 2 3 4 5 6 7 8 9 10; do echo "Starting Pi"; sleep 1; done; exec "$@"',
    "pi-startup",
    ...command,
  ];
}

export function doctorCommand(template: string, turnTimeoutSeconds: number) {
  return [
    "bun",
    "packages/cli/src/index.ts",
    "doctor",
    "--template",
    template,
    "--turn-timeout-seconds",
    String(turnTimeoutSeconds),
  ];
}

export async function runDoctorCheck(options: DoctorCheckOptions, run: DoctorRunner) {
  const turnTimeoutSeconds = options.turnTimeoutSeconds ?? DEFAULT_TURN_TIMEOUT_SECONDS;
  const { stdout } = await run(doctorCommand(options.template, turnTimeoutSeconds), {
    POCKETCODER_URL: options.baseUrl,
    POCKETCODER_KEY: options.key,
  });
  // A zero exit code is not enough: only this line means the correlated turn
  // came back through the relay.
  if (!stdout.includes("doctor: ok")) {
    throw new Error(`doctor did not report ok for template ${options.template}:\n${stdout}`);
  }
  return stdout;
}
