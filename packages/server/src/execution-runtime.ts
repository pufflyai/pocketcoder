import { ExecutionDispatcher } from "@pstdio/pocketcoder-runtime-core";
import type { BuildDeps } from "./app";
import type { InputStorage } from "./attachments/input-storage";
import type { Hub } from "./control-channel/hub";
import { processTransport } from "./control-channel/process-dispatch";
import { conversationTransport, executionTransport } from "./conversations/execution-transport";
import type { Readiness } from "./observability/health";

export function composeExecutionDispatcher(
  deps: BuildDeps & { readiness: Readiness },
  hub: Hub,
  inputs: InputStorage | undefined,
  log: (message: string) => void,
) {
  const { store, driver, limits, readiness } = deps;
  return new ExecutionDispatcher({
    store,
    concurrency: Math.max(1, limits.globalActiveWorkspaces),
    canDispatch: () => !deps.maintenance?.active,
    onError: (error) => log(`execution dispatch failed: ${String(error)}`),
    onHealth: (failed) => readiness.set("execution-dispatch", failed ? "failed" : "ok"),
    transport: executionTransport(
      processTransport({ store, hub, driver, inputs }),
      conversationTransport({ store, hub, driver, inputs, readCapacity: deps.inputStorageOptions?.capacity }),
    ),
    inspect: (workspace) => {
      const ref = { kind: workspace.providerKind ?? "", id: "", ...workspace.providerRef };
      return driver.inspectState?.(ref) ?? driver.inspect(ref);
    },
  });
}
