export interface StoreLifecycle {
  acknowledgeJournal?(): Promise<void>;
  journalStatus(): { configured: boolean; lastAcknowledgedAt: Date | null; pendingSince: Date | null };
  init(): Promise<void>;
  acquireCoordinatorLease(): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
