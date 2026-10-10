import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { createPGliteFixture } from "@pstdio/pocketcoder-db/testing";
import { resolveWarmPools, WarmPoolManager } from "@pstdio/pocketcoder-runtime-core";
import { KubernetesDriver } from "./kubernetes";
import { kubectl } from "./kubernetes-command";
import { KUBERNETES_DIGEST_ANNOTATION, KUBERNETES_POOL_LABEL } from "./kubernetes-labels";
import { LAUNCH_PHASE } from "./kubernetes-uncommitted";

const namespace = process.env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
const run = (args: string[], input?: string) => kubectl("kubectl", namespace, args, input);

describe.skipIf(process.env.POCKETCODER_KUBERNETES_CONFORMANCE !== "1")(
  "warm cleanup with real Kubernetes and PGlite",
  () => {
    test("known non-admission settles, uncertain leased admission retains owner and capacity", async () => {
      const f = await createPGliteFixture("pc-warm-cleanup");
      let inputName: string | undefined;
      let mismatchedJob: string | undefined;
      const unknown = `pocketcoder-pool-${randomUUID()}`;
      try {
        const parsed = parseTemplateManifest({
          ...f.parsed.manifest,
          metadata: { name: `warm-${randomUUID()}` },
          spec: { ...f.parsed.manifest.spec, persistence: { mounts: [] } },
        });
        const template = (
          await f.store.upsertTemplate({
            name: parsed.manifest.metadata.name,
            version: parsed.manifest.spec.version,
            digest: parsed.digest,
            description: null,
            spec: parsed.manifest.spec,
          })
        ).row;
        const driver = new KubernetesDriver({
          namespace,
          runtimeClassName: `missing-${randomUUID()}`,
          captureTerminationEvidence: true,
        });
        const pools = await resolveWarmPools(
          f.store,
          [{ template: template.name, minReady: 1, maxWarmAgeMs: 60_000, missPolicy: "cold", waitTimeoutMs: 0 }],
          driver.kind,
          1,
        );
        const manager = new WarmPoolManager({
          store: f.store,
          driver,
          pools,
          workspaceServerUrl: "http://controller.test",
          secrets: { generate: () => randomUUID(), digest: (value) => new TextEncoder().encode(value) },
          connections: { assign: () => false, isConnected: () => false, close: () => {} },
        });
        await run(
          ["create", "-f", "-"],
          JSON.stringify({
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: {
              name: unknown,
              labels: { [KUBERNETES_POOL_LABEL]: randomUUID() },
              annotations: { [KUBERNETES_DIGEST_ANNOTATION]: template.digest },
            },
            spec: {
              suspend: true,
              template: {
                spec: {
                  restartPolicy: "Never",
                  automountServiceAccountToken: false,
                  containers: [{ name: "probe", image: parsed.manifest.spec.image }],
                },
              },
            },
          }),
        );
        await manager.reconcile();
        expect(await run(["get", "job", unknown, "--ignore-not-found", "-o", "name"])).not.toBe("");
        const runtime = (await f.store.listWarmPoolRuntimes())[0];
        if (!runtime?.providerRef) throw new Error("Warm cleanup did not retain its receipt");
        expect(runtime.state).toBe("failed");
        expect(runtime.providerRef.terminationEvidence).toBeDefined();
        inputName = `pocketcoder-pool-${runtime.id}-input`;
        expect(await run(["get", "secret", inputName, "--ignore-not-found", "-o", "json"])).toBe("");

        // A crash after submission claim cannot be distinguished from a delayed Job request.
        await run(
          ["create", "-f", "-"],
          JSON.stringify({
            apiVersion: "v1",
            kind: "Secret",
            type: "Opaque",
            metadata: {
              name: inputName,
              labels: { [KUBERNETES_POOL_LABEL]: runtime.id },
              annotations: { [LAUNCH_PHASE]: "submitting", [KUBERNETES_DIGEST_ANNOTATION]: runtime.templateDigest },
            },
          }),
        );
        const { terminationEvidence: _proof, ...ref } = runtime.providerRef;
        await f.store.updateWarmPoolRuntime(
          runtime.id,
          { state: "ready", providerRef: ref, readyAt: new Date() },
          new Date(),
        );
        const id = randomUUID();
        const inserted = await f.store.insertWorkspace({
          id,
          principalId: f.principal.id,
          externalId: id,
          idempotencyKey: id,
          requestDigest: digestOf({ id }),
          templateId: template.id,
          templateSnapshot: snapshotOf(parsed),
          launchInput: {},
          metadata: {},
          deadlineAt: new Date(Date.now() + 60_000),
          createdAt: new Date(),
        });
        if (inserted.kind === "capacity_exceeded") throw new Error("Unexpected queue capacity failure");
        const workspace = inserted.workspace;
        expect(
          await manager.tryLease(
            workspace,
            {
              workspace_id: id,
              server_url: "http://controller.test",
              registration_secret: randomUUID(),
              template_digest: template.digest,
              template_name: template.name,
              template_version: template.version,
              launch_mode: "create",
            },
            new Uint8Array([1]),
            new Date(Date.now() + 60_000),
          ),
        ).toBe("deferred");
        expect((await f.store.getWorkspace(id))?.state).toBe("terminating");
        expect((await f.store.getWorkspace(id))?.providerRef?.id).toBe(ref.id);
        expect((await f.store.countActive()).global).toBe(1);
        await manager.reconcile();
        const rows = await f.store.listWarmPoolRuntimes();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.state).toBe("draining");
        expect(await run(["get", "secret", inputName, "--ignore-not-found", "-o", "name"])).not.toBe("");
        mismatchedJob = ref.id as string;
        await run(
          ["create", "-f", "-"],
          JSON.stringify({
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: {
              name: mismatchedJob,
              labels: { [KUBERNETES_POOL_LABEL]: runtime.id },
              annotations: { [KUBERNETES_DIGEST_ANNOTATION]: "sha256:mismatch" },
            },
            spec: {
              suspend: true,
              template: {
                spec: {
                  restartPolicy: "Never",
                  automountServiceAccountToken: false,
                  containers: [{ name: "probe", image: parsed.manifest.spec.image }],
                },
              },
            },
          }),
        );
        await manager.reconcile();
        expect(await run(["get", "job", mismatchedJob, "--ignore-not-found", "-o", "name"])).not.toBe("");
        expect((await f.store.getWarmPoolRuntime(runtime.id))?.state).toBe("draining");
      } finally {
        await run(["delete", "job", unknown, "--ignore-not-found", "--wait=true"]);
        if (mismatchedJob) await run(["delete", "job", mismatchedJob, "--ignore-not-found", "--wait=true"]);
        if (inputName) await run(["delete", "secret", inputName, "--ignore-not-found"]);
        await f.dispose();
      }
    }, 30_000);
  },
);
