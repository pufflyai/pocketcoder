import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPGliteFixture, insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { cleanupWarmProvider, reconcileProviders, stopWorkspaceProvider } from "@pstdio/pocketcoder-runtime-core";
import { KubernetesDriver } from "./kubernetes";
import { kubectl, resourceName } from "./kubernetes-command";
import { EVIDENCE_FINALIZER } from "./kubernetes-evidence";
import { KUBERNETES_DIGEST_ANNOTATION, KUBERNETES_POOL_LABEL, KUBERNETES_WORKSPACE_LABEL } from "./kubernetes-labels";
import { hasMatchingKubernetesTermination } from "./kubernetes-runtime-proof";

const namespace = process.env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
const run = (args: string[], input?: string) => kubectl("kubectl", namespace, args, input);

type Fixture = Awaited<ReturnType<typeof createPGliteFixture>>;
type Lifecycle = "running" | "finished";

// A 0.8 Job: same name, labels and Pod finalizer as today, but its UID was never saved.
async function createLegacyJob(name: string, label: string, owner: string, digest: string, lifecycle: Lifecycle) {
  const metadata = { labels: { [label]: owner }, annotations: { [KUBERNETES_DIGEST_ANNOTATION]: digest } };
  const job = JSON.parse(
    await run(
      ["create", "-f", "-", "-o", "json"],
      JSON.stringify({
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name, ...metadata },
        spec: {
          backoffLimit: 0,
          // The deadline ends the Job; a zero TTL then starts its deletion, as 0.8's TTL did after an hour.
          ...(lifecycle === "finished" ? { activeDeadlineSeconds: 2, ttlSecondsAfterFinished: 0 } : {}),
          template: {
            metadata: { ...metadata, finalizers: [EVIDENCE_FINALIZER] },
            spec: {
              restartPolicy: "Never",
              automountServiceAccountToken: false,
              terminationGracePeriodSeconds: 1,
              containers: [{ name: "workspace", image: "registry.k8s.io/pause:3.10", imagePullPolicy: "IfNotPresent" }],
            },
          },
        },
      }),
    ),
  );
  await waitFor(`${name} ${lifecycle}`, async () => {
    const pods = JSON.parse(await run(["get", "pods", "-l", `job-name=${name}`, "-o", "json"])).items;
    if (lifecycle === "running") return pods[0]?.status?.containerStatuses?.[0]?.state?.running;
    const current = await run(["get", "job", name, "--ignore-not-found", "-o", "json"]);
    return current && JSON.parse(current).metadata.deletionTimestamp;
  });
  return job.metadata.uid as string;
}

async function waitFor(what: string, check: () => Promise<unknown>) {
  const deadline = Date.now() + 60_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

async function cleanup(name: string) {
  const pods = JSON.parse(await run(["get", "pods", "-l", `job-name=${name}`, "-o", "json"]));
  for (const pod of pods.items)
    await run(["patch", "pod", pod.metadata.name, "--type=merge", "-p", '{"metadata":{"finalizers":[]}}']);
  await run(["delete", "job", name, "--ignore-not-found", "--wait=true"]);
}

async function legacyWorkspace(f: Fixture) {
  const workspace = await insertTestWorkspace(f, randomUUID());
  const providerRef = {
    kind: "kubernetes",
    id: resourceName(workspace.id),
    name: resourceName(workspace.id),
    namespace,
  };
  await f.store.transition(workspace.id, {
    from: ["queued"],
    to: "provisioning",
    at: new Date(),
    patch: { providerKind: "kubernetes", providerRef },
  });
  await f.store.transition(workspace.id, { from: ["provisioning"], to: "terminating", at: new Date() });
  return workspace;
}

async function legacyWarmRuntime(f: Fixture) {
  const id = randomUUID();
  const name = `pocketcoder-pool-${id}`;
  const now = new Date();
  await f.store.insertWarmPoolRuntime({
    id,
    templateId: f.template.id,
    templateName: f.template.name,
    templateVersion: f.template.version,
    templateDigest: f.template.digest,
    driverKind: "kubernetes",
    eligibilityFingerprint: "legacy",
    state: "draining",
    providerRef: { kind: "kubernetes", id: name, name, namespace, poolRuntimeId: id },
    enrollmentDigest: null,
    enrollmentExpiresAt: null,
    workspaceId: null,
    createdAt: now,
    updatedAt: now,
    readyAt: null,
    leasedAt: null,
    failureCode: null,
  });
  return { id, name };
}

describe.skipIf(process.env.POCKETCODER_KUBERNETES_CONFORMANCE !== "1")(
  "legacy Kubernetes Job identities with real Kubernetes and PGlite",
  () => {
    test.each(["running", "finished"] as const)(
      "startup recovers a %s workspace Job and cleanup proves its termination",
      async (lifecycle) => {
        const f = await createPGliteFixture("pc-legacy-workspace");
        const workspace = await legacyWorkspace(f);
        const name = resourceName(workspace.id);
        try {
          const uid = await createLegacyJob(
            name,
            KUBERNETES_WORKSPACE_LABEL,
            workspace.id,
            workspace.templateDigest,
            lifecycle,
          );
          const driver = new KubernetesDriver({ namespace, captureTerminationEvidence: true });

          await reconcileProviders({ store: f.store, driver });
          const recovered = await f.store.getWorkspace(workspace.id);
          if (!recovered) throw new Error("Workspace disappeared");
          await stopWorkspaceProvider(f.store, driver, recovered, 1, new Date());

          const saved = (await f.store.getWorkspace(workspace.id))?.providerRef;
          expect(saved?.jobUid).toBe(uid);
          expect(hasMatchingKubernetesTermination({ jobUid: uid }, saved?.terminationEvidence as never)).toBe(true);
          expect(await run(["get", "job", name, "--ignore-not-found", "-o", "name"])).toBe("");
        } finally {
          await cleanup(name);
          await f.dispose();
        }
      },
      90_000,
    );

    test("startup recovers a legacy warm runtime Job and cleanup proves its termination", async () => {
      const f = await createPGliteFixture("pc-legacy-warm");
      const runtime = await legacyWarmRuntime(f);
      try {
        const uid = await createLegacyJob(
          runtime.name,
          KUBERNETES_POOL_LABEL,
          runtime.id,
          f.template.digest,
          "running",
        );
        const driver = new KubernetesDriver({ namespace, captureTerminationEvidence: true });

        await reconcileProviders({ store: f.store, driver });
        const recovered = await f.store.getWarmPoolRuntime(runtime.id);
        if (!recovered) throw new Error("Warm runtime disappeared");
        await cleanupWarmProvider(f.store, driver, recovered, new Date());

        const saved = (await f.store.getWarmPoolRuntime(runtime.id))?.providerRef;
        expect(saved?.jobUid).toBe(uid);
        expect(hasMatchingKubernetesTermination({ jobUid: uid }, saved?.terminationEvidence as never)).toBe(true);
        expect(await run(["get", "job", runtime.name, "--ignore-not-found", "-o", "name"])).toBe("");
      } finally {
        await cleanup(runtime.name);
        await f.dispose();
      }
    }, 90_000);

    test.each([
      { name: "a missing Job", digest: null },
      { name: "a Job for another template", digest: "sha256:another-template" },
    ])(
      "startup keeps an unproved identity for $name and reports it",
      async ({ digest }) => {
        const f = await createPGliteFixture("pc-legacy-unproved");
        const workspace = await legacyWorkspace(f);
        const name = resourceName(workspace.id);
        const logs: string[] = [];
        try {
          if (digest) await createLegacyJob(name, KUBERNETES_WORKSPACE_LABEL, workspace.id, digest, "running");
          const driver = new KubernetesDriver({ namespace, captureTerminationEvidence: true });

          await reconcileProviders({ store: f.store, driver, log: (message) => logs.push(message) });

          expect((await f.store.getWorkspace(workspace.id))?.providerRef?.jobUid).toBeUndefined();
          expect(logs.some((message) => message.includes(workspace.id))).toBe(true);
        } finally {
          await cleanup(name);
          await f.dispose();
        }
      },
      90_000,
    );
  },
);
