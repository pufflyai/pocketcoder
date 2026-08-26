export interface KubernetesToleration {
  key?: string;
  operator?: "Exists" | "Equal";
  value?: string;
  effect: "NoSchedule";
}

export interface KubernetesSchedulingOptions {
  nodeSelector?: Record<string, string>;
  tolerations?: KubernetesToleration[];
}

export function schedulingFields(options: KubernetesSchedulingOptions) {
  return {
    ...(options.nodeSelector ? { nodeSelector: options.nodeSelector } : {}),
    ...(options.tolerations?.length ? { tolerations: options.tolerations } : {}),
  };
}

export function resourceRequirements(resources: {
  cpu: string;
  memory: string;
  ephemeralStorage?: string;
}) {
  const values = {
    cpu: resources.cpu,
    memory: resources.memory,
    ...(resources.ephemeralStorage ? { "ephemeral-storage": resources.ephemeralStorage } : {}),
  };
  return { requests: values, limits: values };
}

export function validateToleration(toleration: KubernetesToleration): void {
  const allowedKeys = new Set(["key", "operator", "value", "effect"]);
  for (const key of Object.keys(toleration)) {
    if (!allowedKeys.has(key)) throw new Error(`unknown toleration field: ${key}`);
  }
  if (toleration.effect !== "NoSchedule") {
    throw new Error("toleration effect must be NoSchedule in this release");
  }
  if (toleration.operator === "Exists" && toleration.value !== undefined) {
    throw new Error("toleration operator Exists must not set a value");
  }
  if (!toleration.key && toleration.operator !== "Exists") {
    throw new Error("an empty or omitted toleration key requires operator Exists");
  }
}
