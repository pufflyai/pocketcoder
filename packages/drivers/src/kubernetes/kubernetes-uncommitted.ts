import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { resourceName } from "./kubernetes-command";
import { jobUidOf } from "./kubernetes-identity";
import { KUBERNETES_DIGEST_ANNOTATION, KUBERNETES_POOL_LABEL, KUBERNETES_WORKSPACE_LABEL } from "./kubernetes-labels";

export const LAUNCH_PHASE = "pocketcoder.dev/launch-phase";
export type LaunchMetadata = {
  uid?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};

class AbsenceUnprovedError extends Error {
  constructor() {
    super("Uncommitted Kubernetes provider absence is unproved");
  }
}

// No receipt alone proves nothing: a create sent before the receipt check may still land. Once the launch's
// registration window has closed no request of that launch can still land, so a namespace without any of its
// objects proves the launch left nothing to clean up.
export async function uncommittedKubernetesWorkspace(
  run: (args: string[]) => Promise<string>,
  namespace: string,
  workspace: Pick<WorkspaceRow, "id" | "templateDigest" | "registrationExpiresAt">,
  at: Date,
) {
  try {
    return await uncommittedKubernetesProvider(run, namespace, workspace);
  } catch (error) {
    if (!(error instanceof AbsenceUnprovedError) || !workspace.registrationExpiresAt) throw error;
    if (at < workspace.registrationExpiresAt) throw error;
    const selector = `${KUBERNETES_WORKSPACE_LABEL}=${workspace.id}`;
    for (const kind of ["pods", "secrets"]) {
      const listed = JSON.parse(await run(["get", kind, "-l", selector, "-o", "json"])) as { items: unknown[] };
      if (listed.items.length) throw error;
    }
    return null;
  }
}

export async function uncommittedKubernetesProvider(
  run: (args: string[]) => Promise<string>,
  namespace: string,
  workspace: Pick<WorkspaceRow, "id" | "templateDigest">,
  warm = false,
) {
  const name = warm ? `pocketcoder-pool-${workspace.id}` : resourceName(workspace.id);
  const label = warm ? KUBERNETES_POOL_LABEL : KUBERNETES_WORKSPACE_LABEL;
  const ref = {
    kind: "kubernetes",
    id: name,
    name,
    namespace,
    ...(warm ? { poolRuntimeId: workspace.id } : {}),
    inputSecret: `${name}-input`,
    egressSecret: `${name}-egress`,
  };
  const job = await run(["get", "job", name, "--ignore-not-found", "-o", "json"]);
  if (job) {
    const metadata = (JSON.parse(job) as { metadata: LaunchMetadata }).metadata;
    if (
      metadata.labels?.[label] !== workspace.id ||
      metadata.annotations?.[KUBERNETES_DIGEST_ANNOTATION] !== workspace.templateDigest
    )
      throw new Error("Uncommitted provider template mismatch");
    return { ...ref, jobUid: jobUidOf({ metadata }) };
  }
  const input = await run(["get", "secret", ref.inputSecret, "--ignore-not-found", "-o", "json"]);
  if (!input) throw new AbsenceUnprovedError();
  const metadata = (JSON.parse(input) as { metadata: LaunchMetadata }).metadata;
  if (
    !metadata.uid ||
    metadata.annotations?.[KUBERNETES_DIGEST_ANNOTATION] !== workspace.templateDigest ||
    metadata.labels?.[label] !== workspace.id
  )
    throw new Error("Uncommitted provider template mismatch");
  const phase = metadata.annotations?.[LAUNCH_PHASE];
  if (phase === "prepared") await claimLaunchPhase(run, ref.inputSecret, metadata, "cleanup");
  else if (phase !== "cleanup") throw new Error("Uncommitted Kubernetes provider admission is uncertain");
  const pods = JSON.parse(await run(["get", "pods", "-l", `${label}=${workspace.id}`, "-o", "json"]));
  if (pods.items.length) throw new Error("Uncommitted Kubernetes provider Pods remain");
  // This receipt commits before Job submission. Retain its identity in the DB before removal.
  return {
    ...ref,
    terminationEvidence: {
      neverAdmitted: { inputUid: metadata.uid, workspaceId: workspace.id, templateDigest: workspace.templateDigest },
    },
  };
}

export async function claimLaunchPhase(
  run: (args: string[]) => Promise<string>,
  name: string,
  metadata: LaunchMetadata,
  next: "submitting" | "cleanup",
) {
  if (!metadata.uid || !metadata.resourceVersion) throw new Error("Launch receipt identity is unavailable");
  await run([
    "patch",
    "secret",
    name,
    "--type=json",
    "-p",
    JSON.stringify([
      { op: "test", path: "/metadata/uid", value: metadata.uid },
      { op: "test", path: "/metadata/resourceVersion", value: metadata.resourceVersion },
      { op: "test", path: "/metadata/annotations/pocketcoder.dev~1launch-phase", value: "prepared" },
      { op: "replace", path: "/metadata/annotations/pocketcoder.dev~1launch-phase", value: next },
    ]),
  ]);
}
