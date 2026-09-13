import type { TemplateSpec } from "@pstdio/pocketcoder-contracts";

export const TEMPLATE_STATUSES = ["active", "available", "retired"] as const;

export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export interface TemplateRow {
  id: string;
  name: string;
  version: string;
  digest: string;
  description: string | null;
  spec: TemplateSpec;
  status: TemplateStatus;
  createdAt: Date;
  retiredAt: Date | null;
}

export interface TemplateUpsert {
  name: string;
  version: string;
  digest: string;
  description: string | null;
  spec: TemplateSpec;
}

export interface UpsertResult {
  row: TemplateRow;
  created: boolean;
  // True when the (name, version) exists with different content. Immutable
  // versions make this a deployment error.
  conflict: boolean;
}

export interface TemplateStore {
  upsertTemplate(input: TemplateUpsert): Promise<UpsertResult>;
  listTemplates(names: string[] | null): Promise<TemplateRow[]>;
  getTemplate(name: string, version?: string): Promise<TemplateRow | null>;
  setTemplateStatus(name: string, version: string, status: TemplateStatus): Promise<void>;
}
