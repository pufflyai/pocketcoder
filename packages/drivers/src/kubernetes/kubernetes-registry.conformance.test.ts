import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import type { WorkspaceLaunch, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { DEFAULT_LIMITS, Scheduler } from "@pstdio/pocketcoder-runtime-core";
import { KubernetesDriver } from "./kubernetes";
import { resourceName } from "./kubernetes-command";
import { applyRegistrySecret } from "./kubernetes-registry";
import { registryFixture, run, waitFor } from "./kubernetes-registry-fixture";
import { KubernetesSecretResolver } from "./kubernetes-secrets";

function launch(image: string): WorkspaceLaunch {
  const snapshot = snapshotOf(
    parseTemplateManifest({
      apiVersion: "pocketcoder.dev/v1alpha1",
      kind: "Template",
      metadata: { name: "private-kind" },
      spec: {
        version: "1.0.0",
        image,
        imagePullSecret: "secretRef:pull-image",
        command: ["sh", "-eu", "-c", "sleep 300"],
        agent: { command: ["true"] },
        resources: { cpu: "1", memory: "128Mi" },
      },
    }),
  );
  const id = randomUUID();
  return {
    workspace: {
      id,
      templateDigest: snapshot.digest,
      templateSnapshot: snapshot,
      deadlineAt: new Date(Date.now() + 60000),
    } as WorkspaceRow,
    input: {
      workspace_id: id,
      server_url: "http://localhost:8091",
      registration_secret: "one-use",
      template_name: snapshot.name,
      template_version: snapshot.version,
      template_digest: snapshot.digest,
      launch_mode: "create",
    },
    mounts: [],
    secrets: [],
  };
}

test("live kubelet rejects wrong registry authority, pulls privately and removes controller Secrets", async () => {
  const f = await registryFixture();
  const driver = new KubernetesDriver({
    namespace: f.namespace,
    imagePullPolicy: "Always",
    resolveRegistry: async () => f.credential,
  });
  const rejected = new KubernetesDriver({
    namespace: f.namespace,
    imagePullPolicy: "Always",
    resolveRegistry: async () => ({ ...f.credential, password: "wrong" }),
  });
  async function pod(workspaceId: string) {
    const rows = JSON.parse(
      await f.kubectl(["get", "pods", "-l", `job-name=${resourceName(workspaceId)}`, "-o", "json"]),
    );
    return rows.items[0] ?? null;
  }
  async function secretNames() {
    return JSON.parse(await f.kubectl(["get", "secrets", "-o", "json"])).items.map(
      (item: { metadata: { name: string } }) => item.metadata.name,
    ) as string[];
  }
  try {
    const wrong = launch(f.image);
    const wrongRef = await rejected.create(wrong);
    const failed = await waitFor(async () => {
      const row = await pod(wrong.workspace.id);
      const waiting = row?.status?.containerStatuses?.[0]?.state?.waiting;
      return ["ErrImagePull", "ImagePullBackOff"].includes(waiting?.reason) ? waiting : null;
    }, "actual authentication rejection");
    expect(failed.message).toMatch(/unauthorized|401|authentication/i);
    expect((await pod(wrong.workspace.id)).status.phase).not.toBe("Running");
    await rejected.remove(wrongRef);
    expect(await secretNames()).toEqual([]);

    const accepted = launch(f.image);
    const ref = await driver.create(accepted);
    const running = await waitFor(async () => {
      const row = await pod(accepted.workspace.id);
      return row?.status?.conditions?.some(
        (condition: { type: string; status: string }) => condition.type === "Ready" && condition.status === "True",
      )
        ? row
        : null;
    }, "authenticated Pod readiness");
    expect(running.spec.imagePullSecrets).toEqual([{ name: `${ref.id}-registry` }]);
    expect(JSON.stringify(running.spec.containers)).not.toContain(f.credential.password);
    expect(JSON.stringify(running.spec.volumes)).not.toContain(`${ref.id}-registry`);
    expect(running.spec.automountServiceAccountToken).toBe(false);
    expect(
      await f.kubectl([
        "exec",
        running.metadata.name,
        "--",
        "sh",
        "-eu",
        "-c",
        "test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token; test ! -e /run/pocketcoder/.dockerconfigjson; cat /run/pocketcoder/input",
      ]),
    ).not.toContain(f.credential.password);
    const resolver = new KubernetesSecretResolver({ namespace: f.namespace });
    const reference = `secretRef:${ref.id}-registry/.dockerconfigjson`;
    const reader = launch(f.image).workspace;
    reader.templateSnapshot.spec.env = { REGISTRY_CONFIG: reference };
    await expect(resolver.resolve(reader)).rejects.toThrow("Controller registry Secrets cannot be read by workspaces");
    reader.launchMode = "create";
    reader.sourceDescriptor = { kind: "git", repository: "app", revision: "main" };
    reader.templateSnapshot.spec.source = {
      kind: "git",
      destinationMount: "worktree",
      allowedRevision: "branch-tag-or-commit",
      repositories: { app: { url: "https://github.com/example/app.git", credential: reference } },
    };
    await expect(resolver.resolveSourceCredential(reader)).rejects.toThrow(
      "Controller registry Secrets cannot be read by workspaces",
    );
    await driver.cleanupInput(accepted.workspace.id);
    expect(await secretNames()).toEqual([]);
    expect((await pod(accepted.workspace.id)).status.phase).toBe("Running");
    await driver.remove(ref);
    expect(await pod(accepted.workspace.id)).toBeNull();
    expect(await secretNames()).toEqual([]);

    const purged = launch(f.image);
    const purgeRef = await driver.create(purged);
    await waitFor(async () => {
      const row = await pod(purged.workspace.id);
      return row?.status?.conditions?.some(
        (condition: { type: string; status: string }) => condition.type === "Ready" && condition.status === "True",
      )
        ? row
        : null;
    }, "workspace readiness before purge");
    expect(await secretNames()).toContain(`${purgeRef.id}-registry`);
    await driver.purgeInput(purged.workspace.id);
    expect(await secretNames()).toEqual([]);
    await driver.remove(purgeRef);

    // A known workspace can lose its controller after Secret apply and before Job creation.
    const interruptedId = randomUUID();
    const interruptedName = `${resourceName(interruptedId)}-registry`;
    await applyRegistrySecret("kubectl", f.namespace, interruptedName, interruptedId, f.credential);
    expect(await secretNames()).toEqual([interruptedName]);
    expect(await driver.list()).toEqual([]);
    await driver.purgeInput(interruptedId);
    expect(await secretNames()).toEqual([]);
  } finally {
    await f.close();
  }
}, 120000);

test.each(["before-job", "after-job"] as const)(
  "registration timeout cleans an uncommitted private launch %s",
  async (stage) => {
    const namespace = `pc-registry-lost-${randomUUID().slice(0, 8)}`;
    const kubectl = (args: string[]) => run(["kubectl", "--namespace", namespace, ...args]);
    const store = await PGliteStore.create();
    try {
      await kubectl(["create", "namespace", namespace]);
      const pending = launch(`registry.example/workspace@sha256:${"a".repeat(64)}`);
      const snapshot = pending.workspace.templateSnapshot;
      const principal = await store.createPrincipal("owner", ["admin"], ["*"]);
      const { row: template } = await store.upsertTemplate({
        name: snapshot.name,
        version: snapshot.version,
        digest: snapshot.digest,
        spec: snapshot.spec,
        description: null,
      });
      const id = pending.workspace.id;
      const now = new Date();
      await store.insertWorkspace({
        id,
        principalId: principal.id,
        externalId: id,
        idempotencyKey: id,
        requestDigest: snapshot.digest,
        templateId: template.id,
        templateSnapshot: snapshot,
        launchInput: null,
        metadata: {},
        deadlineAt: pending.workspace.deadlineAt,
        createdAt: now,
      });
      await store.transition(id, {
        from: ["queued"],
        to: "provisioning",
        at: now,
        patch: { registrationExpiresAt: new Date(now.getTime() - 1) },
      });
      const secret = `${resourceName(id)}-registry`;
      await applyRegistrySecret("kubectl", namespace, secret, id, {
        server: "registry.example",
        username: "synthetic",
        password: randomUUID(),
      });
      const driver = new KubernetesDriver({
        namespace,
        resolveRegistry: async () => ({
          server: "registry.example",
          username: "synthetic",
          password: randomUUID(),
        }),
      });
      if (stage === "after-job")
        await driver.create({ ...pending, workspace: (await store.getWorkspace(id)) as WorkspaceRow });
      const scheduler = new Scheduler({
        store,
        driver,
        limits: DEFAULT_LIMITS,
        workspaceServerUrl: "http://127.0.0.1:8091",
        secrets: { generate: () => randomUUID(), digest: (value) => Buffer.from(value) },
        connections: { isConnected: () => false, shutdown: () => false, signal: () => false, close: () => {} },
      });
      await scheduler.tick();
      expect(JSON.parse(await kubectl(["get", "secrets", "-o", "json"])).items).toEqual([]);
      expect((await store.getWorkspace(id))?.state).toBe("failed");
      expect(JSON.parse(await kubectl(["get", "jobs", "-o", "json"])).items).toEqual([]);
    } finally {
      await store.close();
      await kubectl(["delete", "namespace", namespace, "--ignore-not-found", "--wait=true", "--timeout=30s"]);
    }
  },
  15000,
);
