export interface PreviewGrantRow {
  id: string;
  workspaceId: string;
  incarnationId: string;
  principalId: string;
  keyId: string;
  subject: string;
  accessRevision: string;
  previews: string[];
  createdAt: Date;
  expiresAt: Date;
  ceilingAt: Date;
  revokedAt: Date | null;
}

export interface PreviewGrantStore {
  create(grant: PreviewGrantRow): Promise<PreviewGrantRow | null>;
  get(id: string): Promise<PreviewGrantRow | null>;
  renew(id: string, revision: string, expiresAt: Date, now: Date): Promise<PreviewGrantRow | null>;
  revoke(id: string, now: Date): Promise<PreviewGrantRow | null>;
}
