export type PhysicalVolume = { driver: string; handle: string };
export type PhysicalInventory = { provider: string; volumeId: string; snapshotIds: string[] };
export type PhysicalDeletion = PhysicalInventory & { verifiedAt: string };
export type PurgeTarget = { id: string; namespace: string };
export type AccountVolumeInventory = {
  accountId: string;
  namespaceUid: string;
  volumes: {
    claimUid: string;
    persistentVolumeUid: string;
    attachmentUids: string[];
    storage: PhysicalVolume;
    provider: PhysicalInventory;
    node: { uid: string; providerId: string } | null;
  }[];
};

export interface PhysicalStorage {
  inventory(volume: PhysicalVolume): Promise<PhysicalInventory>;
  removeAndVerify(inventory: PhysicalInventory): Promise<PhysicalDeletion>;
}
