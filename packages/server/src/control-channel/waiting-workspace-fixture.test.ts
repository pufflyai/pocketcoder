import { randomUUID } from "node:crypto";
import { snapshotOf, type WorkloadTemplateSnapshot } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";

// Public canonical admission stays closed. The internal process proof uses the
// existing lifecycle policy envelope with the exact canonical identity attached.
export async function seedWaitingWorkspace(store: Store, snapshot: WorkloadTemplateSnapshot) {
  const policy = fixtureTemplateEcho();
  policy.manifest.spec.services = {};
  policy.manifest.spec.timeouts.idle = "1s";
  const principal = await store.createPrincipal(randomUUID(), ["admin"], ["*"]);
  const { row: template } = await store.upsertTemplate({
    name: snapshot.name,
    version: snapshot.version,
    digest: snapshot.digest,
    description: null,
    spec: policy.manifest.spec,
  });
  const id = randomUUID();
  const result = await store.insertWorkspace({
    id,
    principalId: principal.id,
    externalId: id,
    idempotencyKey: id,
    requestDigest: id,
    templateId: template.id,
    templateSnapshot: {
      ...snapshotOf(policy),
      name: snapshot.name,
      version: snapshot.version,
      digest: snapshot.digest,
    },
    launchInput: null,
    metadata: {},
    createdAt: new Date(),
    deadlineAt: new Date(Date.now() + 600000),
  });
  if (result.kind !== "created") throw new Error("Fixture workspace was not created");
  return { workspace: result.workspace, template };
}
