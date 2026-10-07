// Owns concrete controller work while the HTTP scope joins its cancellable read wait.
import type {
  RuntimeOperations as ControllerOperations,
  Store,
  WorkspaceDriver,
  WorkspaceSecretResolver,
  WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";

// These public service contracts expose asynchronous methods. Preserve the concrete
// receiver so class-private state and driver behavior remain owned by that service.
function ownedProperty<T extends object>(target: T, key: string | symbol, operations: ControllerOperations) {
  const value = Reflect.get(target, key, target);
  if (typeof value !== "function") return value;
  return (...args: unknown[]) => operations.run(() => Reflect.apply(value, target, args));
}

function ownService<T extends object>(service: T, operations: ControllerOperations): T {
  return new Proxy(service, { get: (target, key) => ownedProperty(target, key, operations) });
}

function ownStore(store: Store, operations: ControllerOperations): Store {
  return new Proxy(store, {
    get(target, key) {
      // This concrete read wait belongs to the HTTP request that awaits it. Its
      // original abort is normal caller settlement, not a failed physical write.
      if (key === "waitForWorkspaceChange") return target.waitForWorkspaceChange.bind(target);
      return ownedProperty(target, key, operations);
    },
  });
}

export function ownControllerServices(
  services: {
    store: Store;
    driver: WorkspaceDriver & { cleanupInput?(workspaceId: string): Promise<void> };
    storageDriver?: WorkspaceStorageDriver;
    secretResolver?: WorkspaceSecretResolver;
  },
  operations: ControllerOperations,
) {
  return {
    store: ownStore(services.store, operations),
    driver: ownService(services.driver, operations),
    ...(services.storageDriver ? { storageDriver: ownService(services.storageDriver, operations) } : {}),
    ...(services.secretResolver ? { secretResolver: ownService(services.secretResolver, operations) } : {}),
  };
}
