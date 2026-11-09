import type { OpenAPIHono } from "@hono/zod-openapi";
import type { ExecutionDispatcher, ManagedQueueLimits, Store } from "@pstdio/pocketcoder-runtime-core";
import type { InputStorage, InputStorageOptions } from "../attachments/input-storage";
import { registerBudgetPolicyRoutes } from "../budgets/policy-routes";
import { registerBudgetUsageRoutes } from "../budgets/usage-routes";
import type { AppEnv } from "../http/middleware";
import type { ModelGatewayConfig } from "../model-gateway/config";
import { createModelGateway } from "../model-gateway/gateway";
import { reconcileGatewayInvocations } from "../model-gateway/reconcile";
import type { WorkspaceService } from "../workspaces/service";
import { registerSessionHistoryRoutes } from "./history-routes";
import { registerProfileRoutes } from "./profile-routes";
import { createSessionRecovery } from "./recovery";
import { registerSessionRoutes } from "./session-routes";
import { registerSessionStopRoutes } from "./stop-routes";
import { registerSessionWorkRoutes } from "./work-routes";

export interface ManagedSessionDeps {
  sessionQueueLimits?: ManagedQueueLimits;
  sessionStopSeconds?: number;
  modelGateway?: ModelGatewayConfig;
  // Tests shorten the durable event poll; it does not bound any resource.
  sessionEventPollMs?: number;
}

// The gateway serves no call until restart reconciliation has settled earlier invocations:
// unclaimed reservations were never sent, claimed ones stay uncertain.
export function composeModelGateway(store: Store, config: ModelGatewayConfig | undefined) {
  if (!config) return undefined;
  const gateway = createModelGateway({
    config,
    budgets: store.managed.budgets,
    resolveGrant: (bearer, turnId) => store.managed.grants.resolve(bearer, turnId, new Date()),
    onBudgetDenied: (identity) => store.managed.requests.budgetDenied(identity, new Date()),
  });
  let reconciled: Promise<unknown> | null = null;
  return async (request: Request) => {
    reconciled ??= reconcileGatewayInvocations(store.managed.budgets).catch((error) => {
      reconciled = null;
      throw error;
    });
    await reconciled;
    return gateway(request);
  };
}

export function registerManagedSessionRoutes(
  app: OpenAPIHono<AppEnv>,
  deps: ManagedSessionDeps & {
    store: Store;
    executionDispatcher: ExecutionDispatcher;
    inputs?: InputStorage;
    inputStorageOptions?: InputStorageOptions;
  },
) {
  const { store, executionDispatcher } = deps;
  registerSessionRoutes(app, store);
  registerSessionWorkRoutes(app, store, {
    inputs: deps.inputs,
    storage: deps.inputStorageOptions,
    queue: deps.sessionQueueLimits,
  });
  registerSessionStopRoutes(app, { store, executionDispatcher, stopSeconds: deps.sessionStopSeconds });
  registerSessionHistoryRoutes(app, store, { pollMs: deps.sessionEventPollMs ?? 250 });
  registerProfileRoutes(app, store);
  registerBudgetPolicyRoutes(app, store);
  registerBudgetUsageRoutes(app, store);
}

// Placement uses the ordinary workspace service, so admission, capacity and lifecycle stay with their owners.
export function composeSessionRecovery(
  store: Store,
  service: WorkspaceService,
  config: ModelGatewayConfig | undefined,
  log: (message: string) => void,
) {
  return createSessionRecovery({
    store,
    launcher: {
      create: async (principal, body, key) => (await service.create(principal, body, key)).workspace,
      stop: async (principal, id) => {
        await service.cancel(principal, id);
      },
    },
    ...(config ? { providerHosts: [new URL(config.upstreamUrl).hostname] } : {}),
    onError: (error) => log(`session placement: ${String(error)}`),
  });
}
