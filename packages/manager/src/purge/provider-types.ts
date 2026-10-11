export type PhysicalVolume = { driver: string; handle: string };
export type PhysicalInventory = { provider: string; volumeId: string; snapshotIds: string[] };
export type PhysicalDeletion = PhysicalInventory & { verifiedAt: string };
export type PurgeTarget = { id: string; namespace: string };
export type DnsRecord = { zone: string; id: number; type: string; name: string };
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
  // Purge only reads DNS. external-dns deletes the account records once its Ingress is gone.
  dnsRecords(label: string, hosts: string[]): Promise<DnsRecord[]>;
  dnsAbsent(label: string, hosts: string[], retained: DnsRecord[]): Promise<void>;
}
