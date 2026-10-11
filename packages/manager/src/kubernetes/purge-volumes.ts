import { z } from "zod";
import type { AccountVolumeInventory, PhysicalStorage, PurgeTarget } from "../purge/provider-types";
import type { kube } from "./command";

const ACCOUNT = "pocketcoder.dev/account";
const Metadata = z.object({
  name: z.string().min(1),
  uid: z.uuid(),
  resourceVersion: z.string().min(1),
  namespace: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
});
const Claim = z.object({
  metadata: Metadata,
  spec: z.object({ volumeName: z.string().min(1) }),
  status: z.object({ phase: z.literal("Bound") }),
});
const Volume = z.object({
  metadata: Metadata,
  spec: z.object({
    claimRef: z.object({ uid: z.uuid(), namespace: z.string(), name: z.string() }).optional(),
    persistentVolumeReclaimPolicy: z.string(),
    csi: z.object({ driver: z.string().min(1), volumeHandle: z.string().min(1) }).optional(),
    hostPath: z.object({ path: z.string().min(1) }).optional(),
    nodeAffinity: z.unknown().optional(),
  }),
});
const Provider = z.object({
  provider: z.string().min(1),
  volumeId: z.string().min(1),
  snapshotIds: z.array(z.string().min(1)),
});
const AnyVolume = Volume.extend({
  spec: Volume.shape.spec.omit({ claimRef: true }).extend({
    claimRef: z
      .object({ namespace: z.string().optional(), uid: z.uuid().optional(), name: z.string().optional() })
      .optional(),
  }),
});
const Attachment = z.object({
  metadata: Metadata,
  spec: z.object({ source: z.object({ persistentVolumeName: z.string().optional() }) }),
});
type PV = z.infer<typeof Volume>;
type PVC = z.infer<typeof Claim>;
type Command = typeof kube;

function storageKey(volume: { driver: string; handle: string }) {
  if (volume.driver !== "kind-owned-hostpath") return `${volume.driver}:${volume.handle}`;
  const { nodeUid, providerId, path } = JSON.parse(volume.handle);
  return JSON.stringify([volume.driver, nodeUid, providerId, path]);
}
function targetOf(id: string, namespace: string) {
  z.uuid().parse(id);
  if (namespace !== `pc-account-${id.replaceAll("-", "")}`) throw new Error("Account namespace differs");
  return { id, namespace };
}
async function items(command: Command, args: string[]) {
  return z.object({ items: z.array(z.unknown()) }).parse(JSON.parse(await command([...args, "-o", "json"]))).items;
}
async function namespaceOf(command: Command, target: PurgeTarget, uid?: string) {
  const output = await command(["get", "namespace", target.namespace, "--ignore-not-found", "-o", "json"]);
  if (!output) {
    if (!uid) throw new Error("Account namespace identity is missing");
    return uid;
  }
  const metadata = Metadata.parse(JSON.parse(output).metadata);
  if (metadata.name !== target.namespace || metadata.labels?.[ACCOUNT] !== target.id || (uid && metadata.uid !== uid))
    throw new Error("Account namespace identity differs");
  return metadata.uid;
}
async function noCompute(command: Command, namespace: string) {
  for (const kind of ["pods", "jobs"])
    if ((await items(command, ["-n", namespace, "get", kind])).length) throw new Error("Account compute remains");
}
function claimBinding(volume: PV, claim: PVC, target: PurgeTarget) {
  const ref = volume.spec.claimRef;
  if (
    claim.metadata.labels?.[ACCOUNT] !== target.id ||
    claim.metadata.namespace !== target.namespace ||
    ref?.uid !== claim.metadata.uid ||
    ref.name !== claim.metadata.name ||
    ref.namespace !== target.namespace ||
    claim.spec.volumeName !== volume.metadata.name
  )
    throw new Error("Account volume binding differs");
}
async function volumeNode(command: Command, volume: z.infer<typeof AnyVolume>) {
  const expression = z
    .object({
      key: z.literal("kubernetes.io/hostname"),
      operator: z.literal("In"),
      values: z.tuple([z.string().min(1)]),
    })
    .strict();
  const term = z.object({ matchExpressions: z.tuple([expression]) }).strict();
  const affinity = z
    .object({ required: z.object({ nodeSelectorTerms: z.tuple([term]) }).strict() })
    .strict()
    .parse(volume.spec.nodeAffinity);
  const hostname = affinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0];
  const nodes = await items(command, ["get", "nodes", "-l", `kubernetes.io/hostname=${hostname}`]);
  if (nodes.length !== 1) throw new Error("Volume node identity is uncertain");
  const node = z
    .object({
      metadata: Metadata,
      spec: z.object({ providerID: z.string().min(1) }),
      status: z.object({ conditions: z.array(z.object({ type: z.string(), status: z.string() })) }),
    })
    .parse(nodes[0]);
  if (
    node.metadata.labels?.["kubernetes.io/hostname"] !== hostname ||
    !node.status.conditions.some((condition) => condition.type === "Ready" && condition.status === "True")
  )
    throw new Error("Volume node is unavailable");
  return { uid: node.metadata.uid, providerId: node.spec.providerID };
}
async function physicalSource(command: Command, volume: PV) {
  if (volume.spec.csi && !volume.spec.hostPath)
    return { storage: { driver: volume.spec.csi.driver, handle: volume.spec.csi.volumeHandle }, node: null };
  if (!volume.spec.hostPath || volume.spec.csi || !volume.spec.claimRef)
    throw new Error("Volume storage identity is missing");
  const node = await volumeNode(command, volume);
  const handle = JSON.stringify({
    claimUid: volume.spec.claimRef.uid,
    nodeUid: node.uid,
    providerId: node.providerId,
    path: volume.spec.hostPath.path,
  });
  return {
    storage: { driver: "kind-owned-hostpath", handle },
    node,
  };
}
async function accountObjects(command: Command, target: PurgeTarget) {
  const claims = (await items(command, ["-n", target.namespace, "get", "pvc"])).map((item) => Claim.parse(item));
  const allVolumes = (await items(command, ["get", "pv"])).map((item) => AnyVolume.parse(item));
  const volumes = allVolumes
    .filter((item) => item.spec.claimRef?.namespace === target.namespace)
    .map((item) => Volume.parse(item));
  return { claims, volumes, allVolumes };
}

export async function inventoryAccountVolumes(
  command: Command,
  input: PurgeTarget,
  storage: PhysicalStorage,
): Promise<AccountVolumeInventory> {
  const target = targetOf(input.id, input.namespace);
  const namespaceUid = await namespaceOf(command, target);
  await noCompute(command, target.namespace);
  const { claims, volumes } = await accountObjects(command, target);
  if (!claims.length || claims.length !== volumes.length) throw new Error("Account volume inventory is incomplete");
  const retained: AccountVolumeInventory["volumes"] = [];
  const attachments = (await items(command, ["get", "volumeattachments"])).map((item) => Attachment.parse(item));
  for (const claim of claims) {
    const volume = volumes.find((volume) => volume.metadata.name === claim.spec.volumeName);
    if (!volume) throw new Error("Account persistent volume is missing");
    claimBinding(volume, claim, target);
    const source = await physicalSource(command, volume);
    if (retained.some((saved) => storageKey(saved.storage) === storageKey(source.storage)))
      throw new Error("Account volumes share physical storage");
    const provider = Provider.parse(await storage.inventory(source.storage));
    if (
      provider.volumeId !== source.storage.handle ||
      new Set(provider.snapshotIds).size !== provider.snapshotIds.length
    )
      throw new Error("Physical volume inventory differs");
    const attachmentUids = attachments
      .filter((item) => item.spec.source.persistentVolumeName === volume.metadata.name)
      .map((item) => item.metadata.uid);
    retained.push({
      claimUid: claim.metadata.uid,
      persistentVolumeUid: volume.metadata.uid,
      attachmentUids,
      ...source,
      provider,
    });
  }
  await namespaceOf(command, target, namespaceUid);
  await noCompute(command, target.namespace);
  return { accountId: target.id, namespaceUid, volumes: retained };
}

async function noOtherBindings(
  command: Command,
  volumes: z.infer<typeof AnyVolume>[],
  retained: AccountVolumeInventory,
  target: PurgeTarget,
) {
  for (const saved of retained.volumes) {
    z.uuid().parse(saved.claimUid);
    z.uuid().parse(saved.persistentVolumeUid);
    z.array(z.uuid()).parse(saved.attachmentUids);
    for (const volume of volumes) {
      if (volume.metadata.uid === saved.persistentVolumeUid) {
        if (volume.spec.claimRef?.namespace !== target.namespace) throw new Error("Retained volume moved accounts");
        continue;
      }
      const sameCsi =
        volume.spec.csi?.driver === saved.storage.driver && volume.spec.csi.volumeHandle === saved.storage.handle;
      const samePath =
        saved.storage.driver === "kind-owned-hostpath" &&
        volume.spec.hostPath?.path === JSON.parse(saved.storage.handle).path;
      const sameNode = samePath && JSON.stringify(await volumeNode(command, volume)) === JSON.stringify(saved.node);
      if (sameCsi || sameNode) throw new Error("Retained physical storage has another binding");
    }
  }
}
async function currentObjects(command: Command, retained: AccountVolumeInventory) {
  const target = targetOf(retained.accountId, `pc-account-${retained.accountId.replaceAll("-", "")}`);
  z.uuid().parse(retained.namespaceUid);
  if (
    !retained.volumes.length ||
    new Set(retained.volumes.map((v) => v.claimUid)).size !== retained.volumes.length ||
    new Set(retained.volumes.map((v) => v.persistentVolumeUid)).size !== retained.volumes.length ||
    new Set(retained.volumes.map((v) => storageKey(v.storage))).size !== retained.volumes.length
  )
    throw new Error("Retained volume inventory is incomplete");
  await namespaceOf(command, target, retained.namespaceUid);
  await noCompute(command, target.namespace);
  const current = await accountObjects(command, target);
  await noOtherBindings(command, current.allVolumes, retained, target);
  for (const claim of current.claims) {
    const saved = retained.volumes.find((volume) => volume.claimUid === claim.metadata.uid);
    const volume = current.volumes.find((volume) => volume.metadata.uid === saved?.persistentVolumeUid);
    if (!saved || !volume) throw new Error("Account claim identity changed");
    claimBinding(volume, claim, target);
  }
  for (const volume of current.volumes) {
    const saved = retained.volumes.find((saved) => saved.persistentVolumeUid === volume.metadata.uid);
    if (!saved || volume.spec.claimRef?.uid !== saved.claimUid || volume.spec.claimRef.namespace !== target.namespace)
      throw new Error("Account persistent volume identity changed");
    const source = await physicalSource(command, volume);
    if (
      source.storage.driver !== saved.storage.driver ||
      source.storage.handle !== saved.storage.handle ||
      JSON.stringify(source.node) !== JSON.stringify(saved.node)
    )
      throw new Error("Retained physical volume identity changed");
  }
  return { target, ...current };
}
async function deleteExact(command: Command, path: string, uid: string) {
  await command(
    ["delete", "--raw", path, "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid },
      propagationPolicy: "Foreground",
    }),
  );
}
async function waitGone(command: Command, args: string[], uid: string) {
  const deadline = Date.now() + 30_000;
  while (true) {
    const output = await command([...args, "--ignore-not-found", "-o", "json"]);
    if (!output) return;
    if (Metadata.parse(JSON.parse(output).metadata).uid !== uid) throw new Error("Volume deletion identity changed");
    if (Date.now() >= deadline) throw new Error("Volume deletion is unconfirmed");
    await Bun.sleep(100);
  }
}
async function waitDetached(command: Command, retained: AccountVolumeInventory) {
  const deadline = Date.now() + 30_000;
  while (true) {
    const volumes = (await items(command, ["get", "pv"])).map((item) => AnyVolume.parse(item));
    const attachments = (await items(command, ["get", "volumeattachments"])).map((item) => Attachment.parse(item));
    const owned = volumes.filter((volume) =>
      retained.volumes.some((saved) => saved.persistentVolumeUid === volume.metadata.uid),
    );
    const ids = retained.volumes.flatMap((volume) => volume.attachmentUids);
    const attached = attachments.some(
      (item) =>
        ids.includes(item.metadata.uid) ||
        owned.some((volume) => volume.metadata.name === item.spec.source.persistentVolumeName),
    );
    if (!attached) return;
    if (Date.now() >= deadline) throw new Error("Account volume attachments remain");
    await Bun.sleep(100);
  }
}

export async function removeAccountVolumes(
  command: Command,
  retained: AccountVolumeInventory,
  storage: PhysicalStorage,
) {
  const initial = await currentObjects(command, retained);
  for (const volume of initial.volumes) {
    // Prevent the provisioner from deleting bytes before explicit provider verification.
    await command([
      "patch",
      "pv",
      volume.metadata.name,
      "--type=json",
      "-p",
      JSON.stringify([
        { op: "test", path: "/metadata/uid", value: volume.metadata.uid },
        { op: "test", path: "/metadata/resourceVersion", value: volume.metadata.resourceVersion },
        { op: "replace", path: "/spec/persistentVolumeReclaimPolicy", value: "Retain" },
      ]),
    ]);
  }
  const prepared = await currentObjects(command, retained);
  if (prepared.volumes.some((volume) => volume.spec.persistentVolumeReclaimPolicy !== "Retain"))
    throw new Error("Volume retention is unconfirmed");
  for (const claim of prepared.claims) {
    await deleteExact(
      command,
      `/api/v1/namespaces/${prepared.target.namespace}/persistentvolumeclaims/${claim.metadata.name}`,
      claim.metadata.uid,
    );
    await waitGone(command, ["-n", prepared.target.namespace, "get", "pvc", claim.metadata.name], claim.metadata.uid);
  }
  await waitDetached(command, retained);
  const afterClaims = await currentObjects(command, retained);
  if (afterClaims.claims.length) throw new Error("Account claims remain");
  const receipts = [];
  for (const saved of retained.volumes) {
    const provider = Provider.parse(saved.provider);
    if (provider.volumeId !== saved.storage.handle) throw new Error("Retained provider volume differs");
    const receipt = Provider.extend({ verifiedAt: z.iso.datetime() }).parse(await storage.removeAndVerify(provider));
    if (
      receipt.provider !== provider.provider ||
      receipt.volumeId !== provider.volumeId ||
      JSON.stringify([...receipt.snapshotIds].sort()) !== JSON.stringify([...provider.snapshotIds].sort())
    )
      throw new Error("Physical deletion receipt differs");
    receipts.push(receipt);
  }
  const verified = await currentObjects(command, retained);
  await waitDetached(command, retained);
  for (const volume of verified.volumes) {
    await deleteExact(command, `/api/v1/persistentvolumes/${volume.metadata.name}`, volume.metadata.uid);
    await waitGone(command, ["get", "pv", volume.metadata.name], volume.metadata.uid);
  }
  const final = await currentObjects(command, retained);
  if (final.claims.length || final.volumes.length) throw new Error("Account volume objects remain");
  await waitDetached(command, retained);
  return receipts;
}
