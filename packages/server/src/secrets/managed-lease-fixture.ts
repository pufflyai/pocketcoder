import { randomUUID } from "node:crypto";
import {
  managed,
  PARALLEL_CONVERSATION_CAPABILITIES,
  parseTemplateManifest,
  runtimeTemplateDefinition,
  snapshotOf,
  type TemplateSnapshot,
} from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { leaseServiceFixture } from "./lease-service-fixture";

type Fixture = Awaited<ReturnType<typeof leaseServiceFixture>>;

// An alpha template whose env reads the `runtime` issuer.
async function alphaTemplate(f: Fixture) {
  const source = parseTemplateManifest({
    ...f.parsed.manifest,
    metadata: { name: "managed-lease" },
    spec: { ...f.parsed.manifest.spec, env: { TOKEN_FILE: "secretRef:runtime" } },
  });
  const { row } = await f.store.upsertTemplate({
    name: "managed-lease",
    version: source.manifest.spec.version,
    digest: source.digest,
    description: null,
    spec: source.manifest.spec,
  });
  return { id: row.id, digest: source.digest, snapshot: snapshotOf(source), parsed: source, row };
}

// The published Pi workload template, whose `gateway` slot names the `runtime` issuer.
async function workloadTemplate(f: Fixture) {
  const manifest = await Bun.file(new URL("../../../../examples/templates/pi-harness.json", import.meta.url)).json();
  manifest.spec.credentialSlots.gateway.policyRef = "runtime";
  const { row } = await f.store.publishTemplate(f.key.id, manifest);
  const definition = runtimeTemplateDefinition(manifest);
  // The snapshot shape the workspace service stores for a published workload template.
  const snapshot: TemplateSnapshot = {
    name: definition.manifest.metadata.name,
    version: definition.manifest.spec.version,
    digest: definition.digest,
    spec: definition.policy,
    ...(definition.workload ? { manifest: definition.workload } : {}),
  };
  return { id: row.id, digest: row.digest, snapshot, parsed: undefined, row };
}

// A credentialed managed profile on the fixture workspace: its template reads the `runtime` slot,
// and a registered binding lets the profile's sessions receive leases from the `runtime` issuer.
export async function credentialedProfile(
  f: Fixture,
  {
    credentialPlacement,
    authorityExpiresAt = new Date(Date.now() + 30_000),
    workload = false,
  }: {
    credentialPlacement?: "exclusive" | "shared";
    authorityExpiresAt?: Date;
    workload?: boolean;
  } = {},
) {
  await f.store.updatePrincipal(f.principal.id, ["admin"], ["*"]);
  await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
  const template = workload ? await workloadTemplate(f) : await alphaTemplate(f);
  const incarnationId = randomUUID();
  await f.context.db
    .update(f.context.tables.workspaces)
    .set({
      templateId: template.id,
      templateDigest: template.digest,
      templateSnapshot: template.snapshot,
      runtimeRegistration: {
        incarnationId,
        containerIdentity: incarnationId,
        profile: "service",
        // An installed producer that runs sessions side by side, so placement may share the workspace.
        producer: {
          workspaceId: f.workspace.id,
          incarnationId,
          templateDigest: template.digest,
          image: `fixture/workspace@${template.digest}`,
          runtime: { digest: template.digest, protocol: "pocketcoder.workload/v1" },
          storage: { identity: "fixture-storage", profile: "controller-readonly/v1" },
          capabilities: [...PARALLEL_CONVERSATION_CAPABILITIES],
          adapters: {
            main: {
              kind: "pi",
              digest: template.digest,
              protocol: "pi-rpc",
              capabilities: [...PARALLEL_CONVERSATION_CAPABILITIES],
            },
          },
        },
      },
    })
    .where(eq(f.context.tables.workspaces.id, f.workspace.id));
  const tokenFile = `${f.issuer.directory}/managed-issuer.token`;
  await Bun.write(tokenFile, f.issuer.authorization.slice(7));
  const config = { url: f.issuer.url, tokenFile, policy: f.issuer.policy, revoke: false };
  const configured: Record<string, managed.ProfileConfig> = {};
  async function profile(placement = credentialPlacement) {
    const profileId = randomUUID();
    configured[profileId] = managed.ProfileConfigSchema.parse({
      template: template.row.name,
      templateVersion: template.row.version,
      issuer: "runtime",
      placement: placement ?? "exclusive",
      limits: { workspacesPerOwner: 5, sessionsPerWorkspace: 5 },
    });
    await f.store.managed.profiles.reconcile(f.principal.id, configured, { runtime: config });
    return {
      profileId,
      async session() {
        const sessionId = randomUUID();
        await f.store.managed.sessions.create(f.key.id, { sessionId, profile: profileId, owner: "test-owner" });
        return { principalId: f.principal.id, sessionId };
      },
    };
  }
  const first = await profile();
  return { template, config, incarnationId, profileId: first.profileId, session: first.session, profile };
}
