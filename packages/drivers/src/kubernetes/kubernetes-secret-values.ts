import { kubectl } from "./kubernetes-command";

export interface SecretValueRef {
  namespace: string;
  name: string;
  key: string;
}

export async function readSecretValue(bin: string, ref: SecretValueRef) {
  let output: string;
  try {
    output = await kubectl(bin, ref.namespace, ["get", "secret", ref.name, "-o", "json"]);
  } catch (error) {
    if (String(error).includes("NotFound")) return null;
    throw error;
  }
  const encoded = (JSON.parse(output) as { data?: Record<string, string> }).data?.[ref.key];
  return encoded ? Buffer.from(encoded, "base64").toString("utf8") : null;
}

// The value travels on stdin, so it never appears in process arguments. Server-side apply keeps
// it out of the last-applied annotation that client-side apply writes.
export async function applySecretValue(bin: string, ref: SecretValueRef, value: string) {
  try {
    await kubectl(
      bin,
      ref.namespace,
      ["apply", "--server-side", "--field-manager=pocketcoder", "--force-conflicts", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        type: "Opaque",
        metadata: {
          name: ref.name,
          namespace: ref.namespace,
          labels: { "app.kubernetes.io/managed-by": "pocketcoder" },
        },
        stringData: { [ref.key]: value },
      }),
    );
  } catch {
    // Admission errors may echo the submitted manifest, which holds the value.
    throw new Error(`Writing Kubernetes Secret ${ref.namespace}/${ref.name} failed`);
  }
}
