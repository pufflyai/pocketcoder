import { randomBytes, randomUUID } from "node:crypto";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { createPGliteFixture } from "@pstdio/pocketcoder-db/testing";
import { createIssuerClient } from "./issuer-client";
import { createTestIssuer } from "./issuer-test-server";
import { createWorkspaceLeaseService } from "./lease-service";
import { createSecretVault } from "./secret-vault";

export async function leaseServiceFixture(
  mode: "memory" | "disk" = "memory",
  sourceUrl = "https://source.example/private.git",
) {
  const db = await createPGliteFixture("issuer-service", mode);
  try {
    const issuer = await createTestIssuer({ sourceUrl });
    try {
      const principal = await db.store.createPrincipal("operator", ["secrets:write"], []);
      const pepper = randomBytes(32).toString("base64url");
      const key = issueMachineKey(pepper);
      await db.store.insertMachineKey({
        id: key.id,
        principalId: principal.id,
        secretDigest: key.secretDigest,
        scopes: [],
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        lastUsedAt: null,
      });
      const encryptionKey = randomBytes(32);
      const vault = createSecretVault(db.store, encryptionKey);
      const config = {
        type: "setup-issuer" as const,
        value: {
          url: issuer.url,
          authorization: issuer.authorization,
          policy: issuer.policy,
        },
      };
      await vault.put(key.id, "source", config);
      const id = randomUUID();
      const snapshot = snapshotOf(db.parsed);
      snapshot.spec.source = {
        kind: "git",
        destinationMount: "worktree",
        allowedRevision: "branch-tag-or-commit",
        repositories: { app: { url: sourceUrl, credential: "secretRef:source" } },
      };
      await db.store.insertWorkspace({
        id,
        principalId: principal.id,
        externalId: id,
        idempotencyKey: id,
        requestDigest: digestOf(id),
        templateId: db.template.id,
        templateSnapshot: snapshot,
        launchInput: null,
        metadata: {},
        sourceDescriptor: { kind: "git", repository: "app", revision: "main" },
        deadlineAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
      });
      const workspace = await db.store.getWorkspace(id);
      if (!workspace) throw new Error("Missing lease workspace");
      await db.store.transition(workspace.id, { from: ["queued"], to: "provisioning", at: new Date() });
      const service = createWorkspaceLeaseService({
        store: db.store,
        vault,
        issuer: createIssuerClient({ ca: issuer.ca }),
      });
      return {
        ...db,
        principal,
        issuer,
        vault,
        config,
        key,
        pepper,
        workspace,
        service,
        encryptionKey,
        async close() {
          try {
            await db.dispose();
          } finally {
            await issuer.close();
          }
        },
      };
    } catch (error) {
      await issuer.close();
      throw error;
    }
  } catch (error) {
    await db.dispose();
    throw error;
  }
}
