import { dockerAuthConfig, type RegistryCredential } from "../registry/registry";
import { kubectl } from "./kubernetes-command";
import { KUBERNETES_WORKSPACE_LABEL } from "./kubernetes-labels";

export async function applyRegistrySecret(
  bin: string,
  namespace: string,
  name: string,
  workspaceId: string,
  credential: RegistryCredential,
) {
  try {
    await kubectl(
      bin,
      namespace,
      ["apply", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        type: "kubernetes.io/dockerconfigjson",
        metadata: { name, namespace, labels: { [KUBERNETES_WORKSPACE_LABEL]: workspaceId } },
        stringData: { ".dockerconfigjson": JSON.stringify(dockerAuthConfig(credential)) },
      }),
    );
  } catch {
    // Admission errors may echo the submitted credential-bearing manifest.
    throw new Error("Private workspace image credential delivery failed");
  }
}
