import type { AgentFrame, ExecSpec } from "@pstdio/pocketcoder-contracts";
import { EXIT_NETWORK_POLICY_FAILED } from "./supervisor-constants";
import { enforcedEnvironment, verifyWritableMemoryPaths } from "./supervisor-utils";

type SendFrame = (type: AgentFrame["type"], payload: unknown) => boolean;

export function clearSourceCredential(exec: ExecSpec) {
  if (exec.source) exec.source.credential = null;
}

export async function preflightNetwork(exec: ExecSpec, send: SendFrame, flushAndClose: () => Promise<void>) {
  if (exec.network.mode !== "restricted") return true;
  send("network_state", { state: "starting" });
  try {
    const response = await fetch(exec.network.health_url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`firewall health returned ${response.status}`);
    send("network_state", { state: "ready" });
    return true;
  } catch (error) {
    send("network_state", {
      state: "degraded",
      detail: error instanceof Error ? error.message.slice(0, 512) : "firewall unavailable",
    });
    await flushAndClose();
    return false;
  }
}

export function startNetworkMonitor(exec: ExecSpec, send: SendFrame, terminate: (code: number) => void) {
  if (exec.network.mode !== "restricted") return null;
  const network = exec.network;
  let failures = 0;
  return setInterval(() => {
    void (async () => {
      try {
        const response = await fetch(network.health_url, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error(`firewall health returned ${response.status}`);
        failures = 0;
      } catch {
        failures += 1;
        if (failures < 3) return;
        send("network_state", {
          state: "degraded",
          detail: "firewall health failed three consecutive probes",
        });
        terminate(EXIT_NETWORK_POLICY_FAILED);
      }
    })();
  }, 5000);
}

export async function probeWritableMemory(exec: ExecSpec, log: (message: string) => void) {
  try {
    await verifyWritableMemoryPaths(exec.security.writable_memory_paths);
    return true;
  } catch (error) {
    log(error instanceof Error ? error.message : "writable memory preflight failed");
    return false;
  }
}

export async function runSetupSteps(
  exec: ExecSpec,
  callbacks: {
    send: SendFrame;
    log(message: string): void;
    pump(stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr"): Promise<void>;
    setSetupPhase(): void;
    signal?: AbortSignal;
  },
) {
  for (const step of exec.setup) {
    if (callbacks.signal?.aborted) return step.name;
    callbacks.setSetupPhase();
    callbacks.send("process_state", { phase: "setup", setup_step: step.name });
    const proc = Bun.spawn(step.command, {
      cwd: step.cwd ?? exec.harness.cwd ?? "/",
      env: enforcedEnvironment(exec, {
        ...step.env,
        POCKETCODER_LAUNCH_MODE: exec.launch_mode,
        ...(exec.source ? { POCKETCODER_SOURCE: JSON.stringify(exec.source) } : {}),
        ...(exec.restore ? { POCKETCODER_RESTORE: JSON.stringify(exec.restore) } : {}),
      }),
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const pumps = [callbacks.pump(proc.stdout, "stdout"), callbacks.pump(proc.stderr, "stderr")];
    const abort = () => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    callbacks.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, step.timeoutSeconds * 1000);
    const code = await proc.exited;
    clearTimeout(timeout);
    await Promise.all(pumps);
    callbacks.signal?.removeEventListener("abort", abort);
    if (code === 0) continue;
    callbacks.log(`setup step ${step.name} failed with exit code ${code}`);
    return step.name;
  }
  return null;
}

export async function runSetupWithCredentials(
  exec: ExecSpec,
  callbacks: Parameters<typeof runSetupSteps>[1] & {
    addSecret(secret: string): void;
    removeSecret(secret: string): void;
  },
) {
  const credential = exec.source?.credential;
  if (credential) callbacks.addSecret(credential);
  try {
    return await runSetupSteps(exec, callbacks);
  } finally {
    if (credential) callbacks.removeSecret(credential);
    clearSourceCredential(exec);
  }
}

export async function reportResolvedSource(exec: ExecSpec, send: SendFrame, log: (message: string) => void) {
  if (!exec.source) return;
  try {
    // Kubernetes owns the volume root; the template fixes the path we trust.
    const proc = Bun.spawn(
      [
        "git",
        "-c",
        `safe.directory=${exec.source.destination}`,
        "-C",
        exec.source.destination,
        "rev-parse",
        "--verify",
        "HEAD",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const commit = stdout.trim().toLowerCase();
    if (code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
      throw new Error("git did not return an immutable commit");
    }
    send("source_resolved", {
      repository: exec.source.repository,
      requested_revision: exec.source.revision,
      resolved_commit: commit,
    });
  } catch (error) {
    log(`source resolution failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
