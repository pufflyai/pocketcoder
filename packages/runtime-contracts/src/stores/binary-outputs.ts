import type { ReadStorageCapacity } from "./storage-reservations";

export interface BinaryOutputRow {
  id: string;
  workspaceId: string;
  principalId: string;
  keyId: string;
  reservationId: string;
  connectionEpoch: number;
  state: "capturing" | "ready" | "deleted";
  grantDigest: Uint8Array | null;
  bytes: number | null;
  digest: string | null;
  expiresAt: Date;
  retainedUntil: Date;
  createdAt: Date;
}
export type BinaryOutputInput = Omit<BinaryOutputRow, "state" | "bytes" | "digest" | "createdAt"> & {
  reservedBytes: number;
};
export interface BinaryOutputStore {
  begin(input: BinaryOutputInput, capacity: ReadStorageCapacity, check: () => void): Promise<BinaryOutputRow>;
  get(id: string): Promise<BinaryOutputRow | null>;
  publish(id: string, bytes: Uint8Array, check: () => void): Promise<BinaryOutputRow>;
  content(id: string, principalId: string): Promise<Uint8Array | null>;
  discard(id: string): Promise<void>;
  prune(at: Date): Promise<void>;
  purge(workspaceId: string): Promise<void>;
}
