export type KubeObject = Record<string, unknown>;

export function object(value: unknown): KubeObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as KubeObject)
    : null;
}

export function at(value: unknown, ...keys: string[]) {
  let current = value;
  for (const key of keys) {
    const currentObject = object(current);
    if (!currentObject) return undefined;
    current = currentObject[key];
  }
  return current;
}

export function named(documents: KubeObject[], kind: string, name: string) {
  return documents.find(
    (document) => document.kind === kind && at(document, "metadata", "name") === name,
  );
}

export function namedContainer(resource: KubeObject | undefined, name: string) {
  const containers = at(resource, "spec", "template", "spec", "containers");
  if (!Array.isArray(containers)) return undefined;
  return containers.map(object).find((container) => container?.name === name) ?? undefined;
}

export function imageError(reference: string) {
  const match = reference.match(/^[^\s@]+@sha256:([0-9a-f]{64})$/);
  if (!match) return `image ${reference} must use repo@sha256:<64 lowercase hex>`;
  const digest = match[1] ?? "";
  if (/^([0-9a-f])\1{63}$/.test(digest)) {
    return `image ${reference} uses an obvious placeholder digest`;
  }
  return null;
}
