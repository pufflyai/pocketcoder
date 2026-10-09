export const STORAGE_RESERVATION_PURPOSES = [
  "checkpoint-upload",
  "checkpoint-index",
  "backup",
  "attachment",
  "screenshot",
] as const;
export const STORAGE_RESERVATION_STATES = ["reserved", "committed", "releasing", "released"] as const;

export interface StorageReservationRow {
  id: string;
  purpose: (typeof STORAGE_RESERVATION_PURPOSES)[number];
  operationId: string | null;
  workspaceId: string | null;
  principalId: string | null;
  state: (typeof STORAGE_RESERVATION_STATES)[number];
  reservedBytes: number;
  reservedFiles: number;
  materializedBytes: number;
  materializedFiles: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  releasedAt: Date | null;
}

export type StorageReservationInput = Pick<
  StorageReservationRow,
  "id" | "purpose" | "operationId" | "workspaceId" | "principalId" | "reservedBytes" | "reservedFiles" | "expiresAt"
>;

export interface PhysicalStorageAmount {
  bytes: number;
  files: number;
}

export interface StorageCapacity {
  workspace: PhysicalStorageAmount;
  principal: PhysicalStorageAmount;
  instance: PhysicalStorageAmount;
  freeDisk: PhysicalStorageAmount & { headroomBytes: number; headroomFiles: number };
}

export type ReadStorageCapacity = () => StorageCapacity | Promise<StorageCapacity>;

export interface StorageReservationUsage {
  workspace: PhysicalStorageAmount;
  principal: PhysicalStorageAmount;
  instance: PhysicalStorageAmount;
  outstanding: PhysicalStorageAmount;
}

export interface StorageReservationStore {
  reserve(
    input: StorageReservationInput,
    readCapacity: ReadStorageCapacity,
    check: () => void,
  ): Promise<StorageReservationRow>;
  get(id: string): Promise<StorageReservationRow | null>;
  usage(workspaceId: string | null, principalId: string | null): Promise<StorageReservationUsage>;
  materialize(id: string, amount: PhysicalStorageAmount, check: () => void): Promise<StorageReservationRow>;
  commit(id: string, check: () => void): Promise<StorageReservationRow>;
  beginRelease(id: string, check: () => void): Promise<StorageReservationRow>;
  release(id: string, checkRemoved: () => void): Promise<StorageReservationRow>;
}
