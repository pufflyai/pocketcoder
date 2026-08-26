import {
  type KubernetesSchedulingOptions,
  type KubernetesToleration,
  validateToleration,
} from "@pstdio/pocketcoder-drivers";

type Environment = Record<string, string | undefined>;

function parseJson(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function parseNodeSelector(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const name = "POCKETCODER_KUBERNETES_NODE_SELECTOR";
  const value = parseJson(raw, name);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  const selector = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(selector)) {
    if (typeof item !== "string") throw new Error(`${name}.${key} must be a string`);
  }
  return selector as Record<string, string>;
}

function optionalString(entry: Record<string, unknown>, key: string, name: string) {
  const value = entry[key];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${name}.${key} must be a string`);
  }
}

function parseTolerations(raw: string | undefined): KubernetesToleration[] {
  if (!raw) return [];
  const name = "POCKETCODER_KUBERNETES_TOLERATIONS";
  const value = parseJson(raw, name);
  if (!Array.isArray(value)) throw new Error(`${name} must be a JSON array`);
  return value.map((item, index) => {
    const itemName = `${name}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${itemName} must be an object`);
    }
    const entry = item as Record<string, unknown>;
    for (const key of ["key", "operator", "value", "effect"]) {
      optionalString(entry, key, itemName);
    }
    if (entry.operator !== undefined && entry.operator !== "Exists" && entry.operator !== "Equal") {
      throw new Error(`${itemName}.operator must be Exists or Equal`);
    }
    const toleration = entry as unknown as KubernetesToleration;
    validateToleration(toleration);
    return toleration;
  });
}

export function resolveKubernetesScheduling(env: Environment): KubernetesSchedulingOptions {
  const nodeSelector = parseNodeSelector(env.POCKETCODER_KUBERNETES_NODE_SELECTOR);
  const tolerations = parseTolerations(env.POCKETCODER_KUBERNETES_TOLERATIONS);
  return {
    ...(nodeSelector ? { nodeSelector } : {}),
    ...(tolerations.length ? { tolerations } : {}),
  };
}
