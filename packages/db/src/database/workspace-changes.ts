import type { WorkspaceStore } from "@pstdio/pocketcoder-runtime-contracts";
import type { DatabaseContext } from "./context";
export function createWorkspaceWaiter(context: DatabaseContext, getWorkspace: WorkspaceStore["getWorkspace"]) {
  return async function waitForWorkspaceChange(
    id: string,
    afterSeq: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (timeoutMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const waiters = context.changes.get(id) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        waiters.delete(settle);
        if (waiters.size === 0) context.changes.delete(id);
      };
      const settle = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("workspace change wait aborted"));
      };
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      waiters.add(settle);
      context.changes.set(id, waiters);
      timer = setTimeout(settle, timeoutMs);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      void getWorkspace(id)
        .then((workspace) => {
          if (!workspace || workspace.changeSeq > afterSeq) settle();
        })
        .catch(fail);
    });
  };
}
