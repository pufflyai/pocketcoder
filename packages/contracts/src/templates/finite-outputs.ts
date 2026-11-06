import type { PersistenceMount } from "../persistence/persistence";
import type { WorkloadTemplate } from "./workload-template";

export function finiteOutputMounts(spec: WorkloadTemplate["spec"]): PersistenceMount[] {
  if (spec.profile !== "finite-process") return [];
  const roots = [...new Set(Object.values(spec.operations).flatMap((operation) => operation.outputRoots))];
  return roots.map((target, index) => ({
    name: `finite-output-${index}`,
    target,
    maxBytes: spec.limits.exportBytes,
    maxFiles: spec.limits.exportFiles,
  }));
}
