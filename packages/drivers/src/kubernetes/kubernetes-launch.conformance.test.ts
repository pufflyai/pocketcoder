import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { kubectl } from "./kubernetes-command";
import { KUBERNETES_DIGEST_ANNOTATION, KUBERNETES_WORKSPACE_LABEL } from "./kubernetes-labels";
import {
  claimLaunchPhase,
  LAUNCH_PHASE,
  type LaunchMetadata,
  uncommittedKubernetesProvider,
} from "./kubernetes-uncommitted";

const namespace = process.env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
const run = (args: string[], input?: string) => kubectl("kubectl", namespace, args, input);

describe.skipIf(process.env.POCKETCODER_KUBERNETES_CONFORMANCE !== "1")("atomic Kubernetes launch receipt", () => {
  for (const winner of ["cleanup", "submitting"] as const) {
    test(`${winner} excludes the other claimant on the real API server`, async () => {
      const workspace = { id: randomUUID(), templateDigest: `sha256:${"a".repeat(64)}` };
      const name = `pocketcoder-ws-${workspace.id}-input`;
      const receipt = JSON.parse(
        await run(
          ["create", "-f", "-", "-o", "json"],
          JSON.stringify({
            apiVersion: "v1",
            kind: "Secret",
            type: "Opaque",
            metadata: {
              name,
              labels: { [KUBERNETES_WORKSPACE_LABEL]: workspace.id },
              annotations: { [LAUNCH_PHASE]: "prepared", [KUBERNETES_DIGEST_ANNOTATION]: workspace.templateDigest },
            },
          }),
        ),
      ) as { metadata: LaunchMetadata };
      try {
        await claimLaunchPhase(run, name, receipt.metadata, winner);
        await expect(
          claimLaunchPhase(run, name, receipt.metadata, winner === "cleanup" ? "submitting" : "cleanup"),
        ).rejects.toThrow();
        if (winner === "cleanup") {
          const ref = await uncommittedKubernetesProvider(run, namespace, workspace);
          if (!("terminationEvidence" in ref)) throw new Error("Non-admission receipt missing");
          expect(ref.terminationEvidence.neverAdmitted.inputUid).toBe(receipt.metadata.uid as string);
        } else {
          await expect(uncommittedKubernetesProvider(run, namespace, workspace)).rejects.toThrow("uncertain");
        }
        const pods = JSON.parse(
          await run(["get", "pods", "-l", `${KUBERNETES_WORKSPACE_LABEL}=${workspace.id}`, "-o", "json"]),
        );
        expect(pods.items).toHaveLength(0);
      } finally {
        await run(["delete", "secret", name, "--ignore-not-found"]);
      }
    }, 30_000);
  }
  test("missing Job and missing receipt do not prove non-admission", async () => {
    await expect(
      uncommittedKubernetesProvider(run, namespace, { id: randomUUID(), templateDigest: "sha256:unknown" }),
    ).rejects.toThrow("unproved");
  }, 30_000);
});
