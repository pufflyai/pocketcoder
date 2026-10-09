import type { ExecSpec } from "@pstdio/pocketcoder-contracts";
import type { SetupCompletion } from "./setup-completion";
import { verifySourceBounds } from "./source-bounds";
import { reportResolvedSource, runSetupWithCredentials } from "./supervisor-setup";

export async function prepareSourceSetup(
  exec: ExecSpec,
  completion: SetupCompletion,
  callbacks: Parameters<typeof runSetupWithCredentials>[1] & { abort: AbortController },
) {
  const expiresAt = exec.source?.credential_expires_at;
  const timer = expiresAt
    ? setTimeout(() => callbacks.abort.abort(), Math.max(0, Date.parse(expiresAt) - Date.now()))
    : null;
  try {
    const failed = await runSetupWithCredentials(exec, { ...callbacks, signal: callbacks.abort.signal });
    if (failed || callbacks.abort.signal.aborted) return failed ?? "source-credential-expired";
    const source = exec.source;
    if (source?.max_bytes && source.max_files) {
      try {
        await verifySourceBounds(source.destination, source.max_bytes, source.max_files);
      } catch {
        callbacks.log("Source exceeds its declared storage limits.");
        return "source-limits";
      }
    }
    await reportResolvedSource(exec, callbacks.send, callbacks.log);
    if (callbacks.abort.signal.aborted) return "source-credential-expired";
    if (expiresAt && !(await completion.wait(expiresAt))) return "source-revocation";
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
