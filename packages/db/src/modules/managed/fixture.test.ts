import { randomUUID } from "node:crypto";
import { managed } from "@pstdio/pocketcoder-contracts";
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
  const profile = {
    name: randomUUID(),
    templateDigest: f.template.digest,
    ...managed.ProfileConfigSchema.parse({
      template: f.template.name,
      placement: "shared",
      limits: { workspacesPerOwner: 2, sessionsPerWorkspace: 5 },
    }),
  };
  return { ...f, keyId, profile, sessionId: randomUUID() };
}
export async function provision(f: Awaited<ReturnType<typeof managedFixture>>) {
  const template = (await f.store.listTemplates(null)).find((t) => t.digest === f.profile.templateDigest)!;
  const config = { ...f.profile, template: template.name, templateVersion: template.version };
  const { name, templateDigest: _digest, ...settings } = config;
  await f.store.managed.profiles.reconcile(f.principal.id, { [name]: settings }, {});
  return f.store.managed.sessions.create(f.keyId, { sessionId: f.sessionId, profile: name, owner: "test-owner" });
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
