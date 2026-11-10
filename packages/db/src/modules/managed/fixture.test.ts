import { randomUUID } from "node:crypto";
import type { managed } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

export async function managedFixture(mode: "memory" | "disk" = "memory") {
  const f = await createPGliteFixture("managed-runtime", mode);
  const keyId = randomUUID();
  await f.store.insertMachineKey({
    id: keyId,
    principalId: f.principal.id,
    secretDigest: new Uint8Array([1]),
    scopes: ["admin"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const scopeId = randomUUID();
  const profile: managed.ExecutionProfile = {
    profileId: randomUUID(),
    revision: 1,
    isolationScopeId: randomUUID(),
    budgetScopeIds: [scopeId],
    templateDigest: f.template.digest,
    credentialBindingId: null,
  };
  return { ...f, keyId, scopeId, profile, sessionId: randomUUID() };
}
export function policy(scopeId: string, revision = 1): managed.BudgetPolicyWrite {
  return {
    scopeId,
    revision,
    period: "utc_day",
    limits: {
      workspaceStarts: 10,
      maxActiveWorkspaces: 2,
      maxRunningRequestsPerSession: 1,
      maxChatProcessesPerWorkspace: 5,
    },
  };
}
export async function provision(f: Awaited<ReturnType<typeof managedFixture>>) {
  await f.store.managed.authority.registerScope(f.keyId, f.scopeId, f.principal.id, true);
  await f.store.managed.authority.provisionProfile(f.keyId, f.principal.id, f.profile);
  await f.store.managed.budgets.writePolicy(f.keyId, policy(f.scopeId), null);
  return f.store.managed.sessions.create(f.keyId, {
    sessionId: f.sessionId,
    profileId: f.profile.profileId,
    profileRevision: 1,
  });
}

export async function bindCompute(f: Awaited<ReturnType<typeof managedFixture>>) {
  const workspace = await insertTestWorkspace(f, randomUUID());
  const incarnationId = randomUUID();
  await f.context.db
    .update(f.context.tables.workspaces)
    .set({
      state: "ready",
      runtimeRegistration: { incarnationId, containerIdentity: incarnationId, profile: "service", producer: null },
    })
    .where(eq(f.context.tables.workspaces.id, workspace.id));
  await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: f.sessionId }, 0, {
    workspaceId: workspace.id,
    incarnationId,
    generation: 1,
  });
  return workspace.id;
}
