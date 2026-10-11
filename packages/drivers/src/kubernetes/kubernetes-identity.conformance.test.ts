import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPGliteFixture, insertTestWorkspace } from "@pstdio/pocketcoder-db/testing";
import { type ProviderRef, stopWorkspaceProvider } from "@pstdio/pocketcoder-runtime-core";
import { KubernetesDriver } from "./kubernetes";
import { kubectl } from "./kubernetes-command";
import { EVIDENCE_ANNOTATION, EVIDENCE_FINALIZER } from "./kubernetes-evidence";
import { deleteResource } from "./kubernetes-identity";
import { KUBERNETES_DIGEST_ANNOTATION, KUBERNETES_WORKSPACE_LABEL } from "./kubernetes-labels";

const namespace = process.env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
const run = (args: string[], input?: string) => kubectl("kubectl", namespace, args, input);

async function suspendedJob(id: string) {
  return JSON.parse(
    await run(
      ["create", "-f", "-", "-o", "json"],
      JSON.stringify({
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: `pc-uid-${id}`,
          labels: { [KUBERNETES_WORKSPACE_LABEL]: id },
          annotations: { [KUBERNETES_DIGEST_ANNOTATION]: "sha256:identity" },
        },
        spec: {
          suspend: true,
          template: {
            metadata: { finalizers: [EVIDENCE_FINALIZER] },
            spec: {
              restartPolicy: "Never",
              containers: [{ name: "probe", image: "unused.invalid/probe:identity" }],
            },
          },
        },
      }),
    ),
  );
}

async function cleanup(name: string) {
  const pods = JSON.parse(await run(["get", "pods", "-l", `job-name=${name}`, "-o", "json"]));
  for (const pod of pods.items)
    await run(["patch", "pod", pod.metadata.name, "--type=merge", "-p", '{"metadata":{"finalizers":[]}}']);
  await run(["delete", "job", name, "--ignore-not-found", "--wait=true"]);
  await run(["delete", "secret", `${name}-input`, "--ignore-not-found"]);
}

type Fixture = Awaited<ReturnType<typeof createPGliteFixture>>;
type Workspace = Awaited<ReturnType<typeof insertTestWorkspace>>;

async function proveColdRetry(f: Fixture, workspace: Workspace, driver: KubernetesDriver, ref: ProviderRef) {
  const deadline = Date.now() + 10_000;
  while (!JSON.parse(await run(["get", "pods", "-l", `job-name=${ref.id}`, "-o", "json"])).items.length) {
    if (Date.now() >= deadline) throw new Error("Identity probe Pod was not admitted");
    await Bun.sleep(100);
  }
  await driver.stop(ref, 1);
  const proof = await driver.terminationEvidence(ref);
  if (!proof) throw new Error("Identity probe termination proof missing");
  expect(ref.jobUid).toBe((proof.job as { metadata: { uid: string } }).metadata.uid);
  expect((proof.pods as unknown[]).length).toBeGreaterThan(0);
  await f.store.updateWorkspace(
    workspace.id,
    { providerKind: "kubernetes", providerRef: { ...ref, terminationEvidence: proof } },
    new Date(),
  );
  const saved = await f.store.getWorkspace(workspace.id);
  if (!saved) throw new Error("Identity probe workspace disappeared");
  await driver.remove(ref);
  await expect(stopWorkspaceProvider(f.store, driver, saved, 1, new Date())).resolves.toBeUndefined();
  await f.store.updateWorkspace(
    workspace.id,
    { providerRef: { ...saved.providerRef, jobUid: randomUUID() } },
    new Date(),
  );
  await expect(stopWorkspaceProvider(f.store, driver, saved, 1, new Date())).rejects.toThrow(
    "Termination evidence unavailable",
  );
}

async function proveWarmClaim(f: Fixture, workspace: Workspace, ref: ProviderRef) {
  const at = new Date();
  await f.store.insertWarmPoolRuntime({
    id: workspace.id,
    templateId: f.template.id,
    templateName: f.template.name,
    templateVersion: f.template.version,
    templateDigest: workspace.templateDigest,
    driverKind: "kubernetes",
    eligibilityFingerprint: "identity-probe",
    state: "ready",
    providerRef: ref,
    enrollmentDigest: null,
    enrollmentExpiresAt: null,
    workspaceId: null,
    createdAt: at,
    updatedAt: at,
    readyAt: at,
    leasedAt: null,
    failureCode: null,
  });
  const claimed = await f.store.claimWarmPoolRuntime({
    workspace,
    driverKind: "kubernetes",
    eligibilityFingerprint: "identity-probe",
    registrationDigest: new Uint8Array([1]),
    registrationExpiresAt: workspace.deadlineAt,
    at,
  });
  if (!claimed || "kind" in claimed) throw new Error("Warm identity probe was not claimed");
  expect(claimed.workspace.providerRef).toEqual(ref);
  expect(claimed.runtime.providerRef).toEqual(ref);
}

describe.skipIf(process.env.POCKETCODER_KUBERNETES_CONFORMANCE !== "1")("exact Kubernetes Job identity", () => {
  test.each(["inspect", "stop", "terminationEvidence", "remove"] as const)(
    "%s rejects a same-name replacement",
    async (operation) => {
      const id = randomUUID();
      const original = await suspendedJob(id);
      const ref: ProviderRef = {
        kind: "kubernetes",
        id: original.metadata.name,
        namespace,
        jobUid: original.metadata.uid,
      };
      try {
        await run(["delete", "job", ref.id, "--wait=true"]);
        const replacement = await suspendedJob(id);
        expect(replacement.metadata.uid).not.toBe(ref.jobUid);
        await run([
          "annotate",
          "job",
          ref.id,
          `${EVIDENCE_ANNOTATION}=${JSON.stringify({ job: { metadata: { uid: replacement.metadata.uid } }, pods: [] })}`,
        ]);
        const driver = new KubernetesDriver({ namespace, captureTerminationEvidence: true });
        const { jobUid: _uid, ...nameOnly } = ref;
        const nameOnlyResult = operation === "stop" ? driver.stop(nameOnly, 1) : driver[operation](nameOnly);
        await expect(nameOnlyResult).rejects.toThrow("identity unavailable");
        const result = operation === "stop" ? driver.stop(ref, 1) : driver[operation](ref);
        await expect(result).rejects.toThrow("provider changed");
        const retained = JSON.parse(await run(["get", "job", ref.id, "-o", "json"]));
        expect(retained.metadata.uid).toBe(replacement.metadata.uid);
      } finally {
        await cleanup(ref.id);
      }
    },
    30_000,
  );

  test.each(["cold", "warm"] as const)(
    "%s launch, recovery and discovery retain the actual UID",
    async (mode) => {
      const f = await createPGliteFixture("pc-job-identity");
      let ref: ProviderRef | undefined;
      try {
        const workspace = await insertTestWorkspace(f, randomUUID());
        const driver = new KubernetesDriver({
          namespace,
          captureTerminationEvidence: true,
          nodeSelector: { "pocketcoder.dev/identity-probe": randomUUID() },
        });
        ref =
          mode === "cold"
            ? await driver.create({
                workspace,
                mounts: [],
                secrets: [],
                input: {
                  workspace_id: workspace.id,
                  server_url: "http://controller.test",
                  registration_secret: randomUUID(),
                  template_digest: workspace.templateDigest,
                  template_name: f.template.name,
                  template_version: f.template.version,
                  launch_mode: "create",
                },
              })
            : await driver.createWarm({
                runtimeId: workspace.id,
                template: workspace.templateSnapshot,
                expiresAt: workspace.deadlineAt,
                input: {
                  pool_runtime_id: workspace.id,
                  server_url: "http://controller.test",
                  enrollment_secret: randomUUID(),
                  template_digest: workspace.templateDigest,
                  template_name: f.template.name,
                  template_version: f.template.version,
                },
              });
        const job = JSON.parse(await run(["get", "job", ref.id, "-o", "json"]));
        expect(ref.jobUid).toBe(job.metadata.uid);
        const recovered: ProviderRef =
          mode === "cold"
            ? await driver.uncommittedProvider(workspace)
            : await driver.uncommittedWarmProvider({ id: workspace.id, templateDigest: workspace.templateDigest });
        expect(recovered.jobUid).toBe(job.metadata.uid);
        const found =
          mode === "cold"
            ? (await driver.list()).find((item) => item.workspaceId === workspace.id)
            : (await driver.listWarm()).find((item) => item.runtimeId === workspace.id);
        expect(found?.ref.jobUid).toBe(job.metadata.uid);
        if (mode === "cold") await proveColdRetry(f, workspace, driver, ref);
        else await proveWarmClaim(f, workspace, ref);
      } finally {
        if (ref) await cleanup(ref.id);
        await f.dispose();
      }
    },
    30_000,
  );

  test("API deletion preconditions retain a replacement and matching removal deletes the exact Job", async () => {
    const job = await suspendedJob(randomUUID());
    const name = job.metadata.name;
    try {
      await expect(deleteResource(run, namespace, "jobs", name, randomUUID())).rejects.toThrow(
        "UID in the precondition",
      );
      expect(JSON.parse(await run(["get", "job", name, "-o", "json"])).metadata.uid).toBe(job.metadata.uid);
      const driver = new KubernetesDriver({ namespace });
      await driver.remove({ kind: "kubernetes", id: name, namespace, jobUid: job.metadata.uid });
      expect(await run(["get", "job", name, "--ignore-not-found", "-o", "json"])).toBe("");
    } finally {
      await cleanup(name);
    }
  }, 30_000);
});
