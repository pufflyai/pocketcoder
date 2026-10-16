import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { digestOf, parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { FilesystemInputStorage, KubernetesDriver, KubernetesSharedStorage } from "@pstdio/pocketcoder-drivers";
import type { InputProjectionRef, ProviderRef, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { measureSharedCapacity } from "./kubernetes-shared-capacity";
import { diagnoseSharedPods } from "./kubernetes-shared-diagnostics";
import { crashAndRestartPublisher, resumePublisher } from "./kubernetes-shared-publisher";

const namespace = "pc-shared";
const nodes = (process.env.FIXTURE_NODES ?? "").split(",");
const root = "/data/shared";
const shared = new KubernetesSharedStorage({
  root,
  checkpointRoot: "/data/private/checkpoints",
  claimName: "shared",
  volumeName: process.env.SHARED_VOLUME as string,
  storageClassName: "pc-qualified-nfs",
  profile: "shared-writer-readonly/v1",
  maxBytes: 16 * 1024 ** 2,
  maxFiles: 64,
  networkPolicyName: "storage-isolation",
  storageCidrs: [`${process.env.STORAGE_ADDRESS}/32`],
});
const canonical = new FilesystemInputStorage("/data/private/inputs", [root]);
await resumePublisher(shared, canonical);
const store = await PGliteStore.create("/data/private/db");
await store.init();
const principal = await store.createPrincipal("shared-fixture", ["admin"], ["*"]);
const parsed = parseTemplateManifest({
  apiVersion: "pocketcoder.dev/v1alpha1",
  kind: "Template",
  metadata: { name: "shared-fixture" },
  spec: {
    version: "1.0.0",
    image: process.env.WORKSPACE_IMAGE,
    command: ["bun", "-e", "setInterval(()=>{},1000)"],
    harness: { command: ["/bin/sleep", "600"] },
    resources: { cpu: "100m", memory: "128Mi", ephemeralStorage: "64Mi" },
    persistence: { mounts: [{ name: "output", target: "/outputs", maxBytes: 4 * 1024 ** 2, maxFiles: 16 }] },
  },
});
const template = (
  await store.upsertTemplate({
    name: parsed.manifest.metadata.name,
    version: "1.0.0",
    digest: parsed.digest,
    description: null,
    spec: parsed.manifest.spec,
  })
).row;
async function workspace() {
  const id = randomUUID();
  const at = new Date();
  const inserted = await store.insertWorkspace({
    id,
    principalId: principal.id,
    externalId: id,
    idempotencyKey: id,
    requestDigest: digestOf({ id }),
    templateId: template.id,
    templateSnapshot: snapshotOf(parsed),
    launchInput: null,
    metadata: {},
    createdAt: at,
    deadlineAt: new Date(at.getTime() + 600_000),
  });
  if (inserted.kind !== "created") throw new Error("Fixture workspace conflict");
  return inserted.workspace;
}
async function kube(args: string[]) {
  const proc = Bun.spawn(["kubectl", "-n", namespace, "--request-timeout=30s", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw new Error(error);
  return output.trim();
}
async function pod(ref: ProviderRef) {
  await kube(["wait", "--for=condition=Ready", "pod", "-l", `job-name=${ref.id}`, "--timeout=30s"]);
  return JSON.parse(await kube(["get", "pods", "-l", `job-name=${ref.id}`, "-o", "json"])).items[0];
}
async function run(podName: string, code: string) {
  return kube(["exec", podName, "--", "bun", "-e", code]);
}
const active: { driver: KubernetesDriver; ref: ProviderRef }[] = [];
function driver(node: string) {
  return new KubernetesDriver({
    namespace,
    sharedStorage: shared,
    runtimeClassName: "pc-runc",
    nodeSelector: { "kubernetes.io/hostname": node },
  });
}
function inputFor(row: WorkspaceRow) {
  return {
    workspace_id: row.id,
    template_digest: row.templateDigest,
    server_url: "http://controller.invalid",
    registration_secret: "one-use-fixture",
    template_name: row.templateName,
    template_version: row.templateVersion,
    launch_mode: "create" as const,
  };
}
async function launch(row: WorkspaceRow, node: string) {
  const allocation = await shared.allocate({
    storageId: randomUUID(),
    workspaceId: row.id,
    mounts: parsed.manifest.spec.persistence.mounts,
    uid: 10001,
    gid: 10001,
    retainForExtraction: true,
  });
  const runtime = driver(node);
  const ref = await runtime.create({
    workspace: row,
    mounts: allocation.mounts,
    secrets: [],
    input: {
      workspace_id: row.id,
      template_digest: row.templateDigest,
      server_url: "http://controller.invalid",
      registration_secret: "one-use-fixture",
      template_name: row.templateName,
      template_version: row.templateVersion,
      launch_mode: "create",
    },
  });
  active.push({ driver: runtime, ref });
  return { allocation, runtime, ref, pod: await pod(ref) };
}
try {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: process.env.STORAGE_ADDRESS, port: 2049 });
    socket.setTimeout(1000);
    socket.on("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Trusted publisher cannot reach storage"));
    });
  });
  console.log("Trusted publisher reaches the live NFS endpoint");
  const row = await workspace();
  const unsupported = new KubernetesDriver({
    namespace,
    sharedStorage: new KubernetesSharedStorage({ ...shared.options, storageClassName: "unsupported-storage" }),
  });
  await assert.rejects(
    unsupported.create({ workspace: row, mounts: [], secrets: [], input: inputFor(row) }),
    /ReadWriteMany/,
  );
  assert.equal(await kube(["get", "secret", `pocketcoder-ws-${row.id}-input`, "--ignore-not-found", "-o", "json"]), "");
  const first = await launch(row, nodes[0] as string);
  assert.equal(
    await run(
      first.pod.metadata.name,
      "await Bun.write('/outputs/probe.txt','writable');console.log(await Bun.file('/outputs/probe.txt').text())",
    ),
    "writable",
  );
  console.log(
    JSON.stringify({ volumeIdentity: first.ref.storageIdentity, runtimeClass: first.pod.spec.runtimeClassName }),
  );
  assert.equal(first.pod.spec.nodeName, nodes[0]);
  assert.equal(first.pod.spec.runtimeClassName, "pc-runc");
  assert.equal(first.pod.spec.automountServiceAccountToken, false);
  assert.equal(first.pod.spec.initContainers?.length ?? 0, 0);
  assert.equal(
    await run(
      first.pod.metadata.name,
      `const {connect}=await import('node:net');await new Promise(resolve=>{const socket=connect({host:${JSON.stringify(process.env.STORAGE_ADDRESS)},port:2049});socket.setTimeout(1000);socket.on('connect',()=>{console.log('REACHABLE');socket.destroy();resolve()});socket.on('timeout',()=>{console.log('DENIED');socket.destroy();resolve()});socket.on('error',()=>{console.log('DENIED');resolve()})})`,
    ),
    "DENIED",
  );
  const bytes = Buffer.from("late canonical input");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const reference = {
    workspaceId: row.id,
    fileId: randomUUID(),
    objectVersion: digest,
    digest,
    name: "late.txt",
    mediaType: "text/plain",
    sizeBytes: bytes.length,
    visibility: "ready" as const,
  };
  const backing = { workspaceId: row.id, fileId: reference.fileId, versionId: randomUUID() };
  const writer = await canonical.create(backing);
  await writer.write(bytes);
  await writer.publish();
  const contents = { workspaceId: row.id, incarnationId: first.ref.jobUid as string, objects: [reference] };
  const projection: InputProjectionRef = {
    kind: "immutable-inputs/v1",
    manifestId: randomUUID(),
    manifest: { ...contents, digest: digestOf(contents) },
    objects: [{ backing, reference }],
  };
  await crashAndRestartPublisher(import.meta.path, projection, shared, canonical);
  const projected = `/inputs/${projection.manifestId}/${reference.fileId}`;
  assert.equal(
    await run(first.pod.metadata.name, `console.log(await Bun.file(${JSON.stringify(projected)}).text())`),
    bytes.toString(),
  );
  for (const operation of [
    `await Bun.write(${JSON.stringify(projected)},'changed')`,
    `await (await import('node:fs/promises')).unlink(${JSON.stringify(projected)})`,
    `await (await import('node:fs/promises')).rename(${JSON.stringify(projected)},'/inputs/replaced')`,
  ]) {
    assert.equal(
      await run(
        first.pod.metadata.name,
        `try { ${operation}; console.log('WRITABLE') } catch(e) { console.log(e.code) }`,
      ),
      "EROFS",
    );
  }
  assert.match(
    await run(
      first.pod.metadata.name,
      `try { await (await import('node:fs/promises')).link(${JSON.stringify(projected)},'/outputs/alias');console.log('WRITABLE') } catch(e) { console.log(e.code) }`,
    ),
    /^(EXDEV|EROFS)$/,
  );
  assert.equal(
    await run(
      first.pod.metadata.name,
      `const fs=await import('node:fs/promises');await fs.symlink(${JSON.stringify(projected)},'/outputs/input-link');try {await Bun.write('/outputs/input-link','changed');console.log('WRITABLE')}catch(e){console.log(e.code)}`,
    ),
    "EROFS",
  );
  await run(first.pod.metadata.name, "await Bun.write('/outputs/result.txt','retained output')");
  const siblingRow = await workspace();
  const sibling = await launch(siblingRow, nodes[1] as string);
  assert.equal(
    await run(
      sibling.pod.metadata.name,
      "console.log((await (await import('node:fs/promises')).readdir('/inputs')).length)",
    ),
    "0",
  );
  const outputMount = first.allocation.mounts[0];
  assert.ok(outputMount);
  await assert.rejects(shared.resolveMount(siblingRow.id, outputMount), /another workspace/);
  await first.runtime.stop(first.ref, 1);
  await first.runtime.remove(first.ref);
  const retained = join(root, "workspaces", first.allocation.ref.id, "output", "result.txt");
  assert.equal(await readFile(retained, "utf8"), "retained output");
  await assert.rejects(shared.deleteStorage(first.allocation.ref), /extraction/);
  const restarted = new KubernetesSharedStorage(shared.options);
  await restarted.publishInputs(projection, canonical);
  const resumed = driver(nodes[1] as string);
  const ref = await resumed.create({
    workspace: row,
    mounts: first.allocation.mounts,
    secrets: [],
    input: {
      workspace_id: row.id,
      template_digest: row.templateDigest,
      server_url: "http://controller.invalid",
      registration_secret: "new-one-use",
      template_name: row.templateName,
      template_version: row.templateVersion,
      launch_mode: "create",
    },
  });
  active.push({ driver: resumed, ref });
  const second = await pod(ref);
  assert.equal(second.spec.nodeName, nodes[1]);
  assert.equal(
    await run(second.metadata.name, `console.log(await Bun.file(${JSON.stringify(projected)}).text())`),
    bytes.toString(),
  );
  assert.equal(
    await run(second.metadata.name, "console.log(await Bun.file('/outputs/result.txt').text())"),
    "retained output",
  );
  await resumed.stop(ref, 1);
  await resumed.remove(ref);
  await restarted.completeExtraction(first.allocation.ref);
  await restarted.deleteStorage(first.allocation.ref);
  await sibling.runtime.stop(sibling.ref, 1);
  await sibling.runtime.remove(sibling.ref);
  await restarted.completeExtraction(sibling.allocation.ref);
  await restarted.deleteStorage(sibling.allocation.ref);
  assert.equal((await restarted.listStorage()).length, 0);
  await restarted.purgeInputs(row.id);
  await measureSharedCapacity(restarted, parsed.manifest.spec.persistence.mounts);
  console.log(
    JSON.stringify({
      result: "passed",
      checks: [
        "late publication",
        "EROFS mutation/unlink/rename",
        "sibling isolation",
        "restart",
        "cross-node visibility",
        "retained output after pod deletion",
        "extraction hold and cleanup retry",
        "RuntimeClass",
      ],
      database: "durable PGlite",
      fixtureBounds: {
        inputFileBytes: 1024 ** 2,
        stagedBytes: 8 * 1024 ** 2,
        inputFiles: 16,
        transfers: 2,
        exportBytes: 4 * 1024 ** 2,
        exportFiles: 16,
        deadlineSeconds: 600,
        finalizationSeconds: 30,
      },
    }),
  );
} catch (error) {
  await diagnoseSharedPods(kube);
  throw error;
} finally {
  for (const { driver: runtime, ref } of active) {
    await runtime.stop(ref, 1).catch(() => {});
    await runtime.remove(ref).catch(() => {});
  }
  await store.close();
}
