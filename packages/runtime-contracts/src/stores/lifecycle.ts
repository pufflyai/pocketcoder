export interface StoreLifecycle {
  acknowledgeJournal?(): Promise<void>;
  init(): Promise<void>;
  acquireCoordinatorLease(): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
