import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { snapshotOf } from "@pstdio/pocketcoder-contracts";
import { DatabaseStore } from "@pstdio/pocketcoder-db";
import {
  createPostgresTestDatabase,
  TEST_DATABASE_URL,
  templateFixture,
  workspaceOf,
} from "@pstdio/pocketcoder-db/testing";
import {
  KUBERNETES_DIGEST_ANNOTATION,
  KUBERNETES_POOL_LABEL,
  KUBERNETES_WORKSPACE_LABEL,
} from "@pstdio/pocketcoder-drivers";
import { runCli } from "../../testing/cli-test-support";

async function fixture(
  job: { uid?: string; owner?: string; digest?: string } = {},
  mode: "cold" | "warm" | "claimed" = "cold",
) {
  const database = await createPostgresTestDatabase("pc_cli_binding");
  const store = await DatabaseStore.openPostgres(database);
  const parsed = templateFixture();
  const principal = await store.createPrincipal("binding-test", ["admin"], ["*"]);
  const { row: template } = await store.upsertTemplate({
    name: "pg-fixture",
    version: "1.0.0",
    digest: parsed.digest,
    description: null,
    spec: parsed.manifest.spec,
  });
  const workspace = workspaceOf(
    await store.insertWorkspace({
      id: crypto.randomUUID(),
      principalId: principal.id,
      externalId: "legacy",
      idempotencyKey: "legacy",
      requestDigest: "binding",
      templateId: template.id,
      templateSnapshot: snapshotOf(parsed),
      launchInput: {},
      metadata: {},
      deadlineAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    }),
  );
  const poolId = crypto.randomUUID();
  const ref = {
    kind: "kubernetes",
    id: mode === "cold" ? `pocketcoder-ws-${workspace.id}` : `pocketcoder-pool-${poolId}`,
    namespace: "binding-test",
    inputSecret: "keep-this-secret-reference",
    ...(mode === "cold" ? {} : { poolRuntimeId: poolId }),
  };
  if (mode !== "warm") {
    await store.transition(workspace.id, {
      from: ["queued"],
      to: "provisioning",
      at: new Date(),
      patch: { providerKind: "kubernetes", providerRef: ref },
    });
    await store.transition(workspace.id, { from: ["provisioning"], to: "terminating", at: new Date() });
  }
  if (mode !== "cold") {
    const at = new Date();
    await store.insertWarmPoolRuntime({
      id: poolId,
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      templateDigest: template.digest,
      driverKind: "kubernetes",
      eligibilityFingerprint: "legacy",
      state: mode === "warm" ? "draining" : "leased",
      providerRef: ref,
      enrollmentDigest: null,
      enrollmentExpiresAt: null,
      workspaceId: mode === "claimed" ? workspace.id : null,
      createdAt: at,
      updatedAt: at,
      readyAt: null,
      leasedAt: null,
      failureCode: null,
    });
  }
  const directory = await mkdtemp(join(tmpdir(), "pc-cli-kubectl-"));
  const script = join(directory, "kubectl");
  await writeFile(
    script,
    `#!/usr/bin/env bun
if (!process.argv.includes("get") || !process.argv.includes("jobs")) process.exit(1);
console.log(${JSON.stringify(
      JSON.stringify({
        items: [
          {
            metadata: {
              name: ref.id,
              uid: job.uid ?? "original-uid",
              labels: {
                [mode === "cold" ? KUBERNETES_WORKSPACE_LABEL : KUBERNETES_POOL_LABEL]:
                  job.owner ?? (mode === "cold" ? workspace.id : poolId),
              },
              annotations: { [KUBERNETES_DIGEST_ANNOTATION]: job.digest ?? workspace.templateDigest },
            },
          },
        ],
      }),
    )});`,
    { mode: 0o755 },
  );
  const env = {
    POCKETCODER_DATABASE_URL: database.url,
    POCKETCODER_DATABASE_SCHEMA: database.schema,
    PATH: `${directory}${delimiter}${process.env.PATH}`,
  };
  const bind = (kind: "workspace" | "warm-runtime", id: string) =>
    runCli(
      [
        "db",
        "bind-kubernetes-job",
        "--kind",
        kind,
        "--id",
        id,
        "--namespace",
        ref.namespace,
        "--job-uid",
        "original-uid",
      ],
      { env },
    );
  return {
    store,
    workspace,
    ref,
    bind: () => (mode === "warm" ? bind("warm-runtime", poolId) : bind("workspace", workspace.id)),
    bindWarm: () => bind("warm-runtime", poolId),
    saved: async () =>
      mode === "warm"
        ? (await store.getWarmPoolRuntime(poolId))?.providerRef
        : (await store.getWorkspace(workspace.id))?.providerRef,
    migrate: () => runCli(["db", "migrate"], { env }),
    async dispose() {
      await store.close();
      await database.drop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)("bind an original Kubernetes Job through the CLI", () => {
  test.each(["cold", "warm"] as const)(
    "%s provider requires the controller to stop, then binds the verified UID and allows migration",
    async (mode) => {
      const f = await fixture({}, mode);
      try {
        const release = await f.store.acquireCoordinatorLease();
        try {
          const blocked = await f.bind();
          expect(blocked.exitCode).not.toBe(0);
          expect(blocked.output).toContain("Stop the controller");
        } finally {
          await release();
        }
        const needsBinding = await f.migrate();
        expect(needsBinding.exitCode).not.toBe(0);
        expect(needsBinding.output).toContain("Kubernetes Job identity is missing");
        const bound = await f.bind();
        expect(bound.exitCode).toBe(0);
        expect(await f.saved()).toEqual({ ...f.ref, jobUid: "original-uid" });
        expect((await f.migrate()).exitCode).toBe(0);
      } finally {
        await f.dispose();
      }
    },
  );

  test("a claimed warm provider binds both rows to the same original UID", async () => {
    const f = await fixture({}, "claimed");
    try {
      expect((await f.bind()).exitCode).toBe(0);
      const needsWarmBinding = await f.migrate();
      expect(needsWarmBinding.exitCode).not.toBe(0);
      expect(needsWarmBinding.output).toContain("warm-runtime");
      expect((await f.bindWarm()).exitCode).toBe(0);
      expect(await f.saved()).toEqual({ ...f.ref, jobUid: "original-uid" });
      expect((await f.migrate()).exitCode).toBe(0);
    } finally {
      await f.dispose();
    }
  });

  test.each([
    { name: "same-name replacement", job: { uid: "replacement-uid" } },
    { name: "different owner", job: { owner: "another-workspace" } },
    { name: "different template", job: { digest: "sha256:another-template" } },
  ])("rejects a $name without changing the saved provider", async ({ job }) => {
    const f = await fixture(job);
    try {
      const rejected = await f.bind();
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.output).toContain("does not match");
      expect((await f.store.getWorkspace(f.workspace.id))?.providerRef).toEqual(f.ref);
    } finally {
      await f.dispose();
    }
  });
});
