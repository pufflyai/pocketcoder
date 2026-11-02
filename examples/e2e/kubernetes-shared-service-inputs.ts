import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  digestOf,
  ExecutionRecordSchema,
  ExecutionRuntimeSchema,
  WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { serviceImageFixture } from "@pstdio/pocketcoder-server/testing/service-image";
import { createKubernetesCluster } from "./kubernetes-cluster";
import { controllerKubeconfig } from "./kubernetes-controller-rbac";
import { startSharedController } from "./kubernetes-shared-controller";
import { startSharedNfs } from "./kubernetes-shared-nfs";

// Uploads a file, runs a service execution on Kubernetes and checks that the
// workload reads the exact bytes through a read-only mount. KEEP_CLUSTER=1 keeps
// the cluster and controller for debugging or for driving a consumer against it.
const namespace = "pc-inputs";
// Policy enforcement is proven by kubernetes-shared-storage.ts; delivery only needs the objects.
const cluster = await createKubernetesCluster();
const cleanup: (() => Promise<unknown>)[] = [() => cluster.close()];
async function waitFor<T>(read: () => Promise<T | null | undefined>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
let controller: Awaited<ReturnType<typeof startSharedController>> | undefined;
try {
  await cluster.kube(["create", "namespace", namespace]);
  const kubeconfig = await controllerKubeconfig(cluster, namespace);
  const storage = await startSharedNfs(cluster, namespace);
  cleanup.unshift(() => storage.close());
  const fixture = await serviceImageFixture(join(cluster.directory, "service-image"));
  cleanup.unshift(() => fixture.remove());
  const loaded = await cluster.loadImage(fixture.tag);
  const manifest = { ...fixture.manifest, spec: { ...fixture.manifest.spec, image: loaded.image } };
  controller = await startSharedController(cluster, {
    kubeconfig: kubeconfig.internal,
    volume: storage.volume,
    env: {
      POCKETCODER_KUBERNETES_NAMESPACE: namespace,
      POCKETCODER_KUBERNETES_SERVICE_ACCOUNT: "default",
      POCKETCODER_WORKLOAD_LIMITS: JSON.stringify(manifest.spec.limits),
      POCKETCODER_STORAGE_BACKEND: "kubernetes-shared",
      POCKETCODER_CHECKPOINT_DIR: "/data/private/checkpoints",
      POCKETCODER_KUBERNETES_SHARED_STORAGE: JSON.stringify({
        ...storage.options,
        root: "/data/shared",
        maxBytes: 33_554_432,
        maxFiles: 256,
      }),
      POCKETCODER_INPUT_STORAGE: JSON.stringify({
        root: "/data/private/inputs",
        limits: {
          fileBytes: 1_048_576,
          stagedBytes: 8_388_608,
          files: 16,
          transfers: 2,
          transferMs: 30_000,
          retentionMs: 600_000,
        },
        principal: { bytes: 16_777_216, files: 32 },
        instance: { bytes: 33_554_432, files: 64 },
        headroom: { bytes: 1, files: 1 },
      }),
    },
  });
  const { url, token } = controller;
  cleanup.unshift(() => controller?.close() ?? Promise.resolve());
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`${method} ${path} ${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  };

  await request("/v1/templates", "POST", { manifest });
  const workspace = WorkspaceResourceSchema.parse(
    await request("/v1/workspaces", "POST", { external_id: randomUUID(), template: { name: manifest.metadata.name } }),
  );
  await waitFor(
    async () => {
      const current = WorkspaceResourceSchema.parse(await request(`/v1/workspaces/${workspace.id}`));
      if (current.state === "failed") throw new Error(`workspace failed: ${JSON.stringify(current)}`);
      return current.state === "ready";
    },
    240_000,
    "Kubernetes service readiness",
  );
  const runtime = ExecutionRuntimeSchema.parse(await request(`/v1/workspaces/${workspace.id}/execution-runtime`));
  assert.equal(runtime.producer.storage.profile, "shared-writer-readonly/v1");
  assert.ok(runtime.producer.capabilities.includes("immutable-inputs"));

  const bytes = "readonly-kubernetes-input";
  const upload = await fetch(`${url}/v1/workspaces/${workspace.id}/attachments/${randomUUID()}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "text/plain",
      "content-length": String(bytes.length),
      "content-disposition": 'attachment; filename="proof.txt"',
      "x-content-sha256": new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    },
    body: bytes,
  });
  assert.equal(upload.status, 201, await upload.clone().text());
  const reference = await upload.json();
  const objects = { workspaceId: runtime.workspaceId, incarnationId: runtime.incarnationId, objects: [reference] };
  const identity = {
    schema: "pocketcoder.conversation/v2",
    authority: "external",
    conversation_id: randomUUID(),
    request_id: randomUUID(),
    turn_id: randomUUID(),
    request_fingerprint: "a".repeat(64),
  };
  await request(`/v1/workspaces/${workspace.id}/conversation/requests`, "POST", identity);
  const facts = {
    execution: {
      workspaceId: runtime.workspaceId,
      incarnationId: runtime.incarnationId,
      owner: "conversation-request",
      requestId: identity.request_id,
    },
    callerPrincipalId: runtime.callerPrincipalId,
    templateDigest: runtime.template.digest,
    adapterDigest: runtime.producer.adapters.main?.digest,
    operation: "message",
    input: {},
    inputs: { ...objects, digest: digestOf(objects) },
    bindingSetDigest: digestOf([]),
  };
  await request(`/v1/workspaces/${workspace.id}/executions`, "POST", {
    acceptance: { ...facts, fingerprint: digestOf(facts) },
    conversationIdentity: identity,
  });
  const result = await waitFor(
    async () => {
      const current = ExecutionRecordSchema.parse(
        await request(
          `/v1/workspaces/${workspace.id}/executions/${identity.request_id}?incarnationId=${encodeURIComponent(runtime.incarnationId)}&owner=conversation-request`,
        ),
      );
      return current.finalizedAt ? current : null;
    },
    60_000,
    "Kubernetes immutable service execution",
  );
  assert.equal(result.phase, "terminal");
  assert.deepEqual(result.outcome, { content: bytes, immutable: true });
  console.log(JSON.stringify({ ok: true, workspace: workspace.id, incarnation: runtime.incarnationId }));
  if (process.env.KEEP_CLUSTER === "1")
    console.log(JSON.stringify({ kept: { cluster: cluster.name, kubeconfig: cluster.kubeconfig, url, token } }));
} catch (error) {
  console.error(await controller?.logs());
  console.error(await cluster.kube(["-n", namespace, "get", "pods,events", "-o", "wide"]).catch(() => ""));
  throw error;
} finally {
  if (process.env.KEEP_CLUSTER !== "1") for (const close of cleanup) await close().catch(() => {});
}
