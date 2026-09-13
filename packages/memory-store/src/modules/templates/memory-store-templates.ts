import { randomUUID } from "node:crypto";
import type { TemplateRow, TemplateStatus, TemplateUpsert, UpsertResult } from "@pstdio/pocketcoder-runtime-contracts";

import type { MemoryState } from "../../state/memory-store-base";

export class MemoryTemplateStore {
  constructor(private readonly context: Pick<MemoryState, "templates">) {}
  async upsertTemplate(input: TemplateUpsert): Promise<UpsertResult> {
    const existing = this.context.templates.find((t) => t.name === input.name && t.version === input.version);
    if (existing) {
      if (existing.digest !== input.digest) {
        return { row: existing, created: false, conflict: true };
      }
      return { row: existing, created: false, conflict: false };
    }
    const row: TemplateRow = {
      id: randomUUID(),
      name: input.name,
      version: input.version,
      digest: input.digest,
      description: input.description,
      spec: input.spec,
      status: "active",
      createdAt: new Date(),
      retiredAt: null,
    };
    // Only the newest loaded version of a name stays "active"; earlier
    // ones remain selectable by explicit version.
    for (const t of this.context.templates) {
      if (t.name === input.name && t.status === "active") {
        t.status = "available";
      }
    }
    this.context.templates.push(row);
    return { row, created: true, conflict: false };
  }

  async listTemplates(names: string[] | null): Promise<TemplateRow[]> {
    return this.context.templates.filter((t) => !names || names.includes(t.name)).map((t) => ({ ...t }));
  }

  async getTemplate(name: string, version?: string): Promise<TemplateRow | null> {
    if (version) {
      return this.context.templates.find((t) => t.name === name && t.version === version) ?? null;
    }
    const active = this.context.templates.filter((t) => t.name === name && t.status === "active");
    return active[active.length - 1] ?? null;
  }

  async setTemplateStatus(name: string, version: string, status: TemplateStatus): Promise<void> {
    const row = this.context.templates.find((t) => t.name === name && t.version === version);
    if (row) {
      row.status = status;
      row.retiredAt = status === "retired" ? new Date() : null;
    }
  }
}
