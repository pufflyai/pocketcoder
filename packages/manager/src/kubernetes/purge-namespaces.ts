import { z } from "zod";
import type { PurgeIntent } from "../purge/intent";
import { createBindingLabel, createDigestLabel, namespaceForAccount } from "../purge/namespace-binding";
import type { kube } from "./command";

const Metadata = z.object({
  name: z.string(),
  uid: z.uuid(),
  labels: z.record(z.string(), z.string()),
});
const Namespace = z.object({ metadata: Metadata });

export async function discoverPurgeNamespaces(command: typeof kube, intent: PurgeIntent) {
  const binding = createDigestLabel(intent.createRequestDigest);
  const selected = z
    .object({ items: z.array(Namespace) })
    .parse(JSON.parse(await command(["get", "namespaces", "-l", `${createBindingLabel}=${binding}`, "-o", "json"])));
  const original = await command([
    "get",
    "namespace",
    namespaceForAccount(intent.accountId),
    "--ignore-not-found",
    "-o",
    "json",
  ]);
  function target({ metadata }: z.infer<typeof Namespace>) {
    const id = z.uuid().parse(metadata.labels["pocketcoder.dev/account"]);
    if (
      metadata.name !== namespaceForAccount(id) ||
      (id !== intent.accountId && metadata.labels[createBindingLabel] !== binding) ||
      (metadata.labels[createBindingLabel] && metadata.labels[createBindingLabel] !== binding)
    )
      throw new Error("Purge namespace create identity differs.");
    return { id, namespace: metadata.name, namespaceUid: metadata.uid };
  }
  const records = selected.items.map(target);
  if (original) {
    const current = target(Namespace.parse(JSON.parse(original)));
    const selectedOriginal = records.find((record) => record.id === current.id);
    if (selectedOriginal && selectedOriginal.namespaceUid !== current.namespaceUid)
      throw new Error("Purge namespace identity changed.");
    if (!selectedOriginal) records.push(current);
  }
  return records;
}
