// Bounds local authenticated control parsing before admitting the original quiesce attempt.
export async function controlRequest(request: Request, instanceId: string) {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/quiesce")
    throw new Error("controller_control_request_invalid");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("controller_control_request_invalid");
  const deadline = performance.now() + 2000;
  const timer = setTimeout(() => {
    void reader.cancel();
  }, 2000);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (performance.now() >= deadline) throw new Error("controller_control_body_expired");
      if (next.done) break;
      size += next.value.length;
      if (size > 512) throw new Error("controller_control_request_too_large");
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel();
    reader.releaseLock();
  }
  const row = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (row.instanceId !== instanceId || row.pid !== process.pid || !Number.isSafeInteger(row.deadlineUtcMs))
    throw new Error("controller_control_target_invalid");
  const milliseconds = row.deadlineUtcMs - Date.now();
  if (milliseconds <= 0 || milliseconds > 30_000) throw new Error("controller_control_deadline_invalid");
  return { signal: AbortSignal.timeout(milliseconds), deadline: performance.now() + milliseconds };
}
