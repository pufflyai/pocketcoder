import type { AgentFrame, ExecSpec } from "@pstdio/pocketcoder-contracts";
import { enforcedEnvironment } from "../bootstrap/supervisor-utils";

type SendFrame = (type: AgentFrame["type"], payload: unknown) => boolean;

export async function prepareCheckpoint(
  operationId: string,
  deadlineMs: number,
  callbacks: {
    exec(): ExecSpec | null;
    send: SendFrame;
    pump(stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr"): Promise<void>;
    child(): { kill(signal: "SIGTERM" | "SIGKILL"): void; exited: Promise<number> } | null;
    childExited(): boolean;
    closeTerminals(): Promise<void>;
    setQuiescing(value: boolean): void;
  },
) {
  await callbacks.closeTerminals();
  const exec = callbacks.exec();
  const hook = exec?.checkpoint_hook;
  callbacks.send("checkpoint_status", { operation_id: operationId, phase: "quiescing" });
  if (!exec || !hook) {
    callbacks.send("checkpoint_status", {
      operation_id: operationId,
      phase: "failed",
      detail: "template has no checkpoint hook",
    });
    return false;
  }
  callbacks.setQuiescing(true);
  try {
    const proc = Bun.spawn(hook.command, {
      cwd: hook.cwd ?? exec.harness?.cwd ?? "/",
      env: enforcedEnvironment(exec, {
        ...hook.env,
        POCKETCODER_CHECKPOINT_OPERATION: operationId,
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const pumps = [callbacks.pump(proc.stdout, "stdout"), callbacks.pump(proc.stderr, "stderr")];
    const timeout = setTimeout(() => proc.kill("SIGKILL"), Math.min(deadlineMs, hook.timeout_seconds * 1000));
    const code = await proc.exited;
    clearTimeout(timeout);
    await Promise.all(pumps);
    callbacks.send("checkpoint_status", {
      operation_id: operationId,
      phase: code === 0 ? "quiesced" : "failed",
      ...(code === 0 ? {} : { detail: `checkpoint hook exited ${code}` }),
    });
    return code === 0;
  } catch (error) {
    callbacks.send("checkpoint_status", {
      operation_id: operationId,
      phase: "failed",
      detail: error instanceof Error ? error.message.slice(0, 512) : "hook failed",
    });
    return false;
  }
}
