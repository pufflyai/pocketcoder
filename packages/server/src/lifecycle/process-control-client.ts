// Calls one finite quiesce attempt through the exact private process-owned localhost transport.
import { readProcessCapability } from "./process-control-capability";

export async function requestProcessQuiescence(options: {
  root: string;
  instanceId: string;
  pid: number;
  timeoutSeconds: number;
}) {
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > 30) {
    throw new Error("controller_control_timeout_invalid");
  }
  const deadline = performance.now() + options.timeoutSeconds * 1000;
  const signal = AbortSignal.timeout(options.timeoutSeconds * 1000);
  const target = await readProcessCapability(options.root, options.instanceId, options.pid);
  signal.throwIfAborted();
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error("controller_control_expired");
  const response = await fetch(`${target.url}/quiesce`, {
    headers: { authorization: target.authorization },
    method: "POST",
    signal,
    body: JSON.stringify({ instanceId: options.instanceId, pid: options.pid, deadlineUtcMs: Date.now() + remaining }),
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("controller_control_response_missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (performance.now() >= deadline) throw new Error("controller_control_expired");
      if (next.done) break;
      size += next.value.length;
      if (size > 512) throw new Error("controller_control_response_too_large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !response.ok ||
    body.instanceId !== options.instanceId ||
    body.pid !== options.pid ||
    body.outcome !== "userspace_quiescent"
  ) {
    throw new Error("controller_control_not_quiescent");
  }
  signal.throwIfAborted();
  if (performance.now() >= deadline) throw new Error("controller_control_expired");
  return { instanceId: options.instanceId, pid: options.pid, outcome: "userspace_quiescent" as const };
}
