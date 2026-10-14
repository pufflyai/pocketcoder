import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type {
  MachineKeyRow,
  PrincipalRow,
  Store,
  TemplateRow,
  WorkspaceInsert,
} from "@pstdio/pocketcoder-runtime-contracts";
import { fixtureTemplateEcho } from "../fixtures/fixtures";

export interface StoreContractInstance {
  store: Store;
  dispose(): Promise<void>;
}

export interface StoreContractHarness {
  enabled?: boolean;
  create(): Promise<StoreContractInstance>;
}

export interface PreparedStore extends StoreContractInstance {
  principal: PrincipalRow;
  machineKey: MachineKeyRow;
  template: TemplateRow;
  workspace(overrides?: Partial<WorkspaceInsert>): WorkspaceInsert;
}

export async function prepareStore(harness: StoreContractHarness): Promise<PreparedStore> {
  const instance = await harness.create();
  const parsed = fixtureTemplateEcho();
  const { row: template } = await instance.store.upsertTemplate({
    name: parsed.manifest.metadata.name,
    version: parsed.manifest.spec.version,
    digest: parsed.digest,
    description: parsed.manifest.metadata.description ?? null,
    spec: parsed.manifest.spec,
  });
  const principal = await instance.store.createPrincipal(`contract-${randomUUID()}`, ["admin"], [template.name]);
  const machineKey: MachineKeyRow = {
    id: randomUUID(),
    principalId: principal.id,
    secretDigest: new Uint8Array([1]),
    scopes: [],
    templateNames: null,
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    issuanceRequestId: null,
    issuanceRequestDigest: null,
    managedPrincipalIds: [],
  };
  await instance.store.insertMachineKey(machineKey);
  let sequence = 0;
  return {
    ...instance,
    principal,
    machineKey,
    template,
    workspace(overrides = {}) {
      sequence += 1;
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence));
      return {
        id: randomUUID(),
        principalId: principal.id,
        externalId: `workspace-${sequence}`,
        idempotencyKey: `key-${sequence}`,
        requestDigest: digestOf({ sequence }),
        templateId: template.id,
        templateSnapshot: snapshotOf(parsed),
        launchInput: null,
        metadata: {},
        deadlineAt: new Date(createdAt.getTime() + 60_000),
        createdAt,
        ...overrides,
      };
    },
  };
}

export async function withStore(
  harness: StoreContractHarness,
  run: (fixture: PreparedStore) => Promise<void>,
): Promise<void> {
  const fixture = await prepareStore(harness);
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}
