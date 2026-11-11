import { randomUUID } from "node:crypto";
import {
  type managed,
  PARALLEL_CONVERSATION_CAPABILITIES,
  parseTemplateManifest,
  snapshotOf,
} from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { leaseServiceFixture } from "./lease-service-fixture";

type Fixture = Awaited<ReturnType<typeof leaseServiceFixture>>;

// A credentialed managed profile on the fixture workspace: its template reads the `runtime` slot,
// and a registered binding lets the profile's sessions receive leases from the `runtime` issuer.
export async function credentialedProfile(
  f: Fixture,
  {
    credentialPlacement,
    authorityExpiresAt = new Date(Date.now() + 30_000),
  }: {
    credentialPlacement?: managed.ExecutionProfile["credentialPlacement"];
    authorityExpiresAt?: Date;
  } = {},
) {
  await f.store.updatePrincipal(f.principal.id, ["admin"], ["*"]);
  await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
  const source = parseTemplateManifest({
    ...f.parsed.manifest,
    metadata: { name: "managed-lease" },
    spec: { ...f.parsed.manifest.spec, env: { TOKEN_FILE: "secretRef:runtime" } },
  });
  const { row: template } = await f.store.upsertTemplate({
    name: "managed-lease",
    version: source.manifest.spec.version,
    digest: source.digest,
    description: null,
    spec: source.manifest.spec,
  });
  const incarnationId = randomUUID();
  await f.context.db
    .update(f.context.tables.workspaces)
    .set({
      templateId: template.id,
      templateDigest: source.digest,
      templateSnapshot: snapshotOf(source),
      runtimeRegistration: {
        incarnationId,
        containerIdentity: incarnationId,
        profile: "service",
        // An installed producer that runs sessions side by side, so placement may share the workspace.
        producer: {
          workspaceId: f.workspace.id,
          incarnationId,
          templateDigest: source.digest,
          image: `fixture/workspace@${source.digest}`,
          runtime: { digest: source.digest, protocol: "pocketcoder.workload/v1" },
          storage: { identity: "fixture-storage", profile: "controller-readonly/v1" },
          capabilities: [...PARALLEL_CONVERSATION_CAPABILITIES],
          adapters: {
            main: {
              kind: "pi",
              digest: source.digest,
              protocol: "pi-rpc",
              capabilities: [...PARALLEL_CONVERSATION_CAPABILITIES],
            },
          },
        },
      },
    })
    .where(eq(f.context.tables.workspaces.id, f.workspace.id));
  const config = await f.vault.resolve("runtime", "runtime-issuer");
  const scopeId = randomUUID();
  const bindingId = randomUUID();
  await f.store.managed.authority.registerScope(f.key.id, scopeId, f.principal.id, true);
  await f.store.managed.authority.registerCredential(f.key.id, {
    bindingId,
    principalId: f.principal.id,
    secretName: "runtime",
    secretVersionId: config.id,
    slots: ["runtime", "extra"],
    authorityExpiresAt,
  });
  await f.store.managed.budgets.writePolicy(
    f.key.id,
    {
      scopeId,
      revision: 1,
      period: "utc_day",
      limits: {
        workspaceStarts: 10,
        maxActiveWorkspaces: 5,
        maxRunningRequestsPerSession: 1,
        maxChatProcessesPerWorkspace: 5,
      },
    },
    null,
  );
  // Each call provisions a new profile on the same template, binding and scope.
  async function profile(placement = credentialPlacement) {
    const profileId = randomUUID();
    await f.store.managed.authority.provisionProfile(f.key.id, f.principal.id, {
      profileId,
      revision: 1,
      isolationScopeId: randomUUID(),
      budgetScopeIds: [scopeId],
      templateDigest: source.digest,
      credentialBindingId: bindingId,
      ...(placement ? { credentialPlacement: placement } : {}),
    });
    return {
      profileId,
      async session() {
        const sessionId = randomUUID();
        await f.store.managed.sessions.create(f.key.id, { sessionId, profileId, profileRevision: 1 });
        return { principalId: f.principal.id, sessionId };
      },
    };
  }
  const first = await profile();
  return {
    source,
    template,
    config,
    scopeId,
    bindingId,
    incarnationId,
    authorityExpiresAt,
    profileId: first.profileId,
    session: first.session,
    profile,
  };
}
