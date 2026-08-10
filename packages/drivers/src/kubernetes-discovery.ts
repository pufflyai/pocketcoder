import type { DiscoveredProvider, DiscoveredWarmProvider } from "@pstdio/pocketcoder-runtime-core";
import {
  KUBERNETES_DIGEST_ANNOTATION,
  KUBERNETES_POOL_LABEL,
  KUBERNETES_WORKSPACE_LABEL,
} from "./kubernetes-labels";

interface JobList {
  items?: Array<{
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    };
  }>;
}

export function discoveredWorkspaces(
  output: string,
  kind: string,
  namespace: string,
): DiscoveredProvider[] {
  const list = JSON.parse(output) as JobList;
  return (list.items ?? []).flatMap((job) => {
    const workspaceId = job.metadata?.labels?.[KUBERNETES_WORKSPACE_LABEL];
    const name = job.metadata?.name;
    const templateDigest = job.metadata?.annotations?.[KUBERNETES_DIGEST_ANNOTATION];
    if (!workspaceId || !name || !templateDigest) return [];
    return [
      {
        workspaceId,
        templateDigest,
        ref: {
          kind,
          id: name,
          name,
          inputSecret: `${name}-input`,
          egressSecret: `${name}-egress`,
          namespace,
        },
      },
    ];
  });
}

export function discoveredWarmRuntimes(
  output: string,
  kind: string,
  namespace: string,
): DiscoveredWarmProvider[] {
  const list = JSON.parse(output) as JobList;
  return (list.items ?? []).flatMap((job) => {
    const runtimeId = job.metadata?.labels?.[KUBERNETES_POOL_LABEL];
    const name = job.metadata?.name;
    const templateDigest = job.metadata?.annotations?.[KUBERNETES_DIGEST_ANNOTATION];
    if (!runtimeId || !name || !templateDigest) return [];
    return [
      {
        runtimeId,
        templateDigest,
        ref: {
          kind,
          id: name,
          name,
          inputSecret: `${name}-input`,
          namespace,
          poolRuntimeId: runtimeId,
          egressSecret: `${name}-egress`,
        },
      },
    ];
  });
}
