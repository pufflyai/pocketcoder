import type { OpenAPIHono } from "@hono/zod-openapi";
import type { ExecutionDispatcher, ManagedQueueLimits, Store } from "@pstdio/pocketcoder-runtime-core";
import type { InputStorage, InputStorageOptions } from "../attachments/input-storage";
import type { LiveTurns } from "../conversations/live-turns";
import type { AppEnv } from "../http/middleware";
import type { WorkspaceService } from "../workspaces/service";
import { registerSessionHistoryRoutes } from "./history-routes";
import { registerSessionPreviewRoutes } from "./preview-routes";
import { registerProfileRoutes } from "./profile-routes";
import { createSessionRecovery, type SessionCredentialOwner } from "./recovery";
import { registerSessionRoutes } from "./session-routes";
import { registerSessionStopRoutes } from "./stop-routes";
import { registerSessionWorkRoutes } from "./work-routes";

export interface ManagedSessionDeps {
  sessionSeedBytes?: number;
  sessionQueueLimits?: ManagedQueueLimits;
  // Tests shorten the durable event poll; it does not bound any resource.
  sessionEventPollMs?: number;
}

export function registerManagedSessionRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ManagedSessionDeps & {
    store: Store;
    liveTurns: LiveTurns;
    executionDispatcher: ExecutionDispatcher;
    inputs?: InputStorage;
    inputStorageOptions?: InputStorageOptions;
    previews: Parameters<typeof registerSessionPreviewRoutes>[2];
  },
) {
  const { store, executionDispatcher } = deps;
  registerSessionRoutes(app, store);
  registerSessionWorkRoutes(app, store, {
    inputs: deps.inputs,
    storage: deps.inputStorageOptions,
    queue: deps.sessionQueueLimits,
  });
  registerSessionStopRoutes(app, { store, executionDispatcher });
  registerSessionHistoryRoutes(app, store, { pollMs: deps.sessionEventPollMs ?? 250, liveTurns: deps.liveTurns });
  registerProfileRoutes(app, store);
  registerSessionPreviewRoutes(app, store, deps.previews);
}

// Placement uses the ordinary workspace service, so admission, capacity and lifecycle stay with their owners.
export function composeSessionRecovery(
  store: Store,
  service: WorkspaceService,
  log: (message: string) => void,
  credentials?: SessionCredentialOwner,
) {
  return createSessionRecovery({
    store,
    ...(credentials ? { credentials } : {}),
    launcher: {
      create: async (principal, body, key, workspaceId) =>
        (await service.create(principal, body, key, workspaceId)).workspace,
      stop: async (principal, id) => {
        await service.cancel(principal, id);
      },
    },
    onError: (error) => log(`session placement: ${String(error)}`),
  });
}
