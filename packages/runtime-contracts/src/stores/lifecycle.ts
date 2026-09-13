export interface StoreLifecycle {
  init(): Promise<void>;
  acquireCoordinatorLease(): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
