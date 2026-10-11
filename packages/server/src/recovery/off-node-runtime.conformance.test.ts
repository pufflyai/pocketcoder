import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOffNodeConfig, restoreOffNodeBackup } from "@pstdio/pocketcoder-db/off-node";
import { createPGliteFixture, insertTestWorkspace, objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { EVIDENCE_FINALIZER, KubernetesDriver } from "@pstdio/pocketcoder-drivers";
import { stopWorkspaceProvider } from "@pstdio/pocketcoder-runtime-core";
import { createControllerBackup } from "../backup/controller-backup";
import { createOffNodeBackup } from "../backup/off-node-backup";
import { loadConfig } from "../config/config";
import { startRecoveryController } from "../lifecycle/lifecycle";
import { createMaintenance } from "../maintenance/maintenance";

const namespace = process.env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
async function kube(args: string[], input?: unknown) {
  const child = Bun.spawn(["kubectl", "--request-timeout=30s", "-n", namespace, ...args], {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && child.stdin) {
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  }
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code) throw new Error(error);
  if (args[0] === "delete") return null;
  return output.trim() ? JSON.parse(output) : null;
}
function privatePost(directory: string, path: string, body: unknown) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request(
      {
        socketPath: join(directory, "admin.sock"),
        path,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          const result = { status: response.statusCode as number, body: JSON.parse(text) };
          console.log(JSON.stringify({ path, ...result }));
          resolve(result);
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
async function job(id: string, warm = false) {
  return kube(["create", "-f", "-", "-o", "json"], {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `pc93-handoff-${id}`,
      labels: { [warm ? "pocketcoder.pool-runtime" : "pocketcoder.workspace"]: id },
    },
    spec: {
      suspend: true,
      template: {
        metadata: { finalizers: [EVIDENCE_FINALIZER] },
        spec: {
          restartPolicy: "Never",
          containers: [{ name: "probe", image: "unused.invalid/handoff:proof" }],
        },
      },
    },
  });
}

test.skipIf(process.env.RUN_S3_INTEGRATION !== "1" || process.env.POCKETCODER_KUBERNETES_CONFORMANCE !== "1")(
  "private restore handoff rejects other identities and retries exact cold, warm and Secret proofs after restart",
  async () => {
    const remote = await objectStorageFixture();
    const f = await createPGliteFixture("pc93-private-handoff", "disk");
    const root = await mkdtemp(join(tmpdir(), "pc93-private-handoff-"));
    const ownedJobs: string[] = [];
    const ownedSecrets: string[] = [];
    let recovery: Awaited<ReturnType<typeof startRecoveryController>> | undefined;
    try {
      const outer = join(root, "outer-key");
      await writeFile(outer, randomBytes(32), { mode: 0o600 });
      const configPath = join(root, "off-node.json");
      await writeFile(
        configPath,
        JSON.stringify({ accountId: randomUUID(), storage: remote.config, encryptionKeyFile: outer }),
        { mode: 0o600 },
      );
      const offNode = await loadOffNodeConfig(configPath);
      const driver = new KubernetesDriver({ namespace, captureTerminationEvidence: true });
      const cold = await insertTestWorkspace(f, "cold");
      const admitted = await job(cold.id);
      ownedJobs.push(admitted.metadata.name);
      const ref = { kind: "kubernetes", id: admitted.metadata.name, namespace, jobUid: admitted.metadata.uid };
      expect(
        await f.store.transition(cold.id, {
          from: ["queued"],
          to: "provisioning",
          at: new Date(),
          patch: { providerKind: "kubernetes", providerRef: ref },
        }),
      ).not.toBeNull();
      const prepared = await insertTestWorkspace(f, "prepared");
      const secretName = `pocketcoder-ws-${prepared.id}-input`;
      ownedSecrets.push(secretName);
      await kube(["create", "-f", "-", "-o", "json"], {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: secretName,
          labels: { "pocketcoder.workspace": prepared.id },
          annotations: {
            "pocketcoder.dev/template-digest": prepared.templateDigest,
            "pocketcoder.dev/launch-phase": "prepared",
          },
        },
        type: "Opaque",
      });
      const preparedRef = await driver.uncommittedProvider(prepared);
      expect(
        await f.store.transition(prepared.id, {
          from: ["queued"],
          to: "provisioning",
          at: new Date(),
          patch: { providerKind: "kubernetes", providerRef: preparedRef },
        }),
      ).not.toBeNull();
      const warmId = randomUUID();
      const warmJob = await job(warmId, true);
      ownedJobs.push(warmJob.metadata.name);
      const warmRef = {
        kind: "kubernetes",
        id: warmJob.metadata.name,
        namespace,
        jobUid: warmJob.metadata.uid,
        poolRuntimeId: warmId,
      };
      await f.store.insertWarmPoolRuntime({
        id: warmId,
        templateId: f.template.id,
        templateName: f.template.name,
        templateVersion: f.template.version,
        templateDigest: f.template.digest,
        driverKind: "kubernetes",
        eligibilityFingerprint: "private-handoff",
        state: "ready",
        providerRef: warmRef,
        enrollmentDigest: null,
        enrollmentExpiresAt: null,
        workspaceId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        readyAt: new Date(),
        leasedAt: null,
        failureCode: null,
      });
      const keys = {
        pepper: randomBytes(32).toString("base64url"),
        eventSigningKey: randomBytes(32).toString("base64url"),
        secretKey: randomBytes(32).toString("base64url"),
      };
      const backup = createOffNodeBackup({
        store: f.store,
        offNode,
        backup: createControllerBackup({ store: f.store, keys, maintenance: createMaintenance() }),
      });
      const receipt = await backup(randomUUID(), new AbortController().signal);
      expect(receipt.runtimes).toHaveLength(3);
      for (const row of [cold, prepared]) {
        const saved = await f.store.getWorkspace(row.id);
        if (!saved) throw new Error("Source runtime missing.");
        await stopWorkspaceProvider(f.store, driver, saved, 1, new Date());
        expect(
          await f.store.transition(row.id, { from: ["provisioning"], to: "canceled", at: new Date() }),
        ).not.toBeNull();
      }
      await driver.stop(warmRef, 1);
      const warmTermination = await driver.terminationEvidence(warmRef);
      expect(warmTermination).not.toBeNull();
      await f.store.updateWarmPoolRuntime(
        warmId,
        { state: "failed", providerRef: { ...warmRef, terminationEvidence: warmTermination } },
        new Date(),
      );
      await driver.remove(warmRef);
      const proof = await backup.runtimeProof(receipt.operationId);
      await offNode.journal.acknowledge(f.store.journalSnapshot());
      await f.store.close();
      const input = {
        operationId: randomUUID(),
        receipt,
        offNode,
        dataDir: join(root, "fresh"),
        checkpointDir: join(root, "checkpoints"),
        journalDir: join(root, "journal"),
      };
      await restoreOffNodeBackup(input);
      const config = loadConfig({
        POCKETCODER_DIR: input.dataDir,
        POCKETCODER_OFF_NODE_CONFIG: configPath,
        POCKETCODER_DRIVER: "kubernetes",
        POCKETCODER_KUBERNETES_NAMESPACE: namespace,
        POCKETCODER_CHECKPOINT_DIR: input.checkpointDir,
      });
      recovery = await startRecoveryController(config, { log: () => {} });
      expect((await privatePost(input.dataDir, "/v1/recovery/claim", { operation_id: input.operationId })).status).toBe(
        409,
      );
      const first = proof.runtimes.find((runtime) => runtime.identity.id === cold.id);
      const secret = proof.runtimes.find((runtime) => runtime.identity.id === prepared.id);
      if (!first || !secret) throw new Error("Bound runtime proof missing.");
      const body = { operation_id: input.operationId, snapshot_id: receipt.snapshotId, ...first };
      for (const invalid of [
        { ...body, operation_id: randomUUID() },
        { ...body, snapshot_id: randomUUID() },
        { ...body, identity: { ...first.identity, id: randomUUID() } },
        { ...body, termination: { ...first.termination, job: { metadata: { uid: randomUUID() } } } },
        {
          ...body,
          ...secret,
          termination: { neverAdmitted: { ...secret.identity.ref.neverAdmitted, inputUid: randomUUID() } },
        },
      ])
        expect((await privatePost(input.dataDir, "/v1/recovery/runtime", invalid)).status).toBe(409);
      expect((await privatePost(input.dataDir, "/v1/recovery/runtime", body)).status).toBe(200);
      await recovery.stop();
      recovery = undefined;
      recovery = await startRecoveryController(config, { log: () => {} });
      expect((await privatePost(input.dataDir, "/v1/recovery/claim", { operation_id: input.operationId })).status).toBe(
        409,
      );
      for (const runtime of proof.runtimes)
        expect(
          (
            await privatePost(input.dataDir, "/v1/recovery/runtime", {
              operation_id: input.operationId,
              snapshot_id: receipt.snapshotId,
              ...runtime,
            })
          ).status,
        ).toBe(200);
      expect((await privatePost(input.dataDir, "/v1/recovery/claim", { operation_id: input.operationId })).status).toBe(
        200,
      );
      const completed = await privatePost(input.dataDir, "/v1/recovery/complete", {});
      expect(completed.status).toBe(200);
      expect(completed.body.complete).toBe(true);
      expect((await kube(["get", "jobs", "-l", "pocketcoder.workspace", "-o", "json"])).items).toEqual([]);
    } finally {
      const runtimeCleanup = await Promise.allSettled([
        recovery?.stop(),
        ...ownedJobs.map((name) => kube(["delete", "job", name, "--ignore-not-found", "--wait=true"])),
        ...ownedSecrets.map((name) => kube(["delete", "secret", name, "--ignore-not-found"])),
      ]);
      const cleanup = [...runtimeCleanup, ...(await Promise.allSettled([f.dispose(), remote.close()]))];
      if (runtimeCleanup[0]?.status === "fulfilled")
        await rm(root, { recursive: true, force: true }).catch((error) =>
          console.error("Owned root cleanup failed", root, error),
        );
      for (const result of cleanup) if (result.status === "rejected") console.error(result.reason);
    }
  },
  60_000,
);
