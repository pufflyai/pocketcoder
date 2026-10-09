import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { fixtureTemplateEcho, fixtureTemplatePersistent } from "@pstdio/pocketcoder-testkit";
import type { Store, WarmPoolConnections } from "../index";

export const secrets = {
  generate: () => `secret-${randomUUID()}`,
  digest: (value: string) => new TextEncoder().encode(value),
};
export const noWorkspaceConnections = {
  isConnected: () => false,
  shutdown: () => false,
  signal: () => false,
  close: () => {},
};

export async function seed(store: Store, persistent = false) {
  const parsed = persistent ? fixtureTemplatePersistent() : fixtureTemplateEcho();
  const template = (
    await store.upsertTemplate({
      name: parsed.manifest.metadata.name,
      version: parsed.manifest.spec.version,
      digest: parsed.digest,
      description: null,
      spec: parsed.manifest.spec,
    })
  ).row;
  const principal = await store.createPrincipal("pool-test", ["admin"], ["*"]);
  return { parsed, template, principal };
}

export async function queue(store: Store, seeded: Awaited<ReturnType<typeof seed>>, name: string) {
  const now = new Date();
  const result = await store.insertWorkspace({
    id: randomUUID(),
    principalId: seeded.principal.id,
    externalId: name,
    idempotencyKey: name,
    requestDigest: digestOf({ name }),
    templateId: seeded.template.id,
    templateSnapshot: snapshotOf(seeded.parsed),
    launchInput: { task: name },
    metadata: {},
    deadlineAt: new Date(now.getTime() + 60_000),
    createdAt: now,
  });
  if (result.kind === "capacity_exceeded") throw new Error("unexpected queue capacity failure");
  return result.workspace;
}

export class Assignments implements WarmPoolConnections {
  readonly inputs: Array<{ runtimeId: string; workspaceId: string }> = [];
  assign(runtimeId: string, input: { workspace_id: string }): boolean {
    this.inputs.push({ runtimeId, workspaceId: input.workspace_id });
    return true;
  }
  isConnected(): boolean {
    return true;
  }
  close(): void {}
}
