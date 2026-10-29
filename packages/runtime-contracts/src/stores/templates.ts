import type { RuntimeTemplatePolicy, TemplateManifest, WorkloadTemplate } from "@pstdio/pocketcoder-contracts";

export const TEMPLATE_STATUSES = ["active", "available", "retired"] as const;

export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export interface TemplateRow {
  id: string;
  name: string;
  version: string;
  digest: string;
  description: string | null;
  spec: RuntimeTemplatePolicy;
  manifest?: WorkloadTemplate | null;
  status: TemplateStatus;
  createdAt: Date;
  retiredAt: Date | null;
}

export interface TemplateUpsert {
  name: string;
  version: string;
  digest: string;
  description: string | null;
  spec: RuntimeTemplatePolicy;
  manifest?: WorkloadTemplate | null;
}

export interface UpsertResult {
  row: TemplateRow;
  created: boolean;
  // True when the (name, version) exists with different content. Immutable
  // versions make this a deployment error.
  conflict: boolean;
}

export interface TemplateStore {
  publishTemplate(
    actorKeyId: string,
    manifest: TemplateManifest | WorkloadTemplate,
  ): Promise<{ row: TemplateRow; created: boolean }>;
  retireTemplate(actorKeyId: string, name: string, version: string): Promise<TemplateRow>;
  upsertTemplate(input: TemplateUpsert): Promise<UpsertResult>;
  listTemplates(names: string[] | null): Promise<TemplateRow[]>;
  getTemplate(name: string, version?: string): Promise<TemplateRow | null>;
}
