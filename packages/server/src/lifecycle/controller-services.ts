// Owns every asynchronous call on the concrete controller services, including detached writes.
import type {
  RuntimeOperations as ControllerOperations,
  Store,
  WorkspaceDriver,
  WorkspaceSecretResolver,
  WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";

// These public service contracts expose asynchronous methods. Preserve the concrete
// receiver so class-private state and driver behavior remain owned by that service.
function ownService<T extends object>(service: T, operations: ControllerOperations): T {
  return new Proxy(service, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => operations.run(() => Reflect.apply(value, target, args));
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
    store: ownService(services.store, operations),
    driver: ownService(services.driver, operations),
    ...(services.storageDriver ? { storageDriver: ownService(services.storageDriver, operations) } : {}),
    ...(services.secretResolver ? { secretResolver: ownService(services.secretResolver, operations) } : {}),
  };
}
