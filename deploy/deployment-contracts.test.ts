import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("maps Kubernetes readiness and liveness to the matching endpoints", async () => {
  const manifest = await readFile(join(import.meta.dir, "kubernetes/pocketcoder.yaml"), "utf8");

  expect(manifest).toContain("readinessProbe:\n            httpGet:\n              path: /readyz");
  expect(manifest).toContain("livenessProbe:\n            httpGet:\n              path: /livez");
});

test("lets bootstrap jobs and admission hooks reach a live controller before it is ready", async () => {
  const manifest = await readFile(join(import.meta.dir, "kubernetes/pocketcoder.yaml"), "utf8");

  expect(manifest).toContain(
    "name: pocketcoder-server-live\nspec:\n  type: ClusterIP\n  publishNotReadyAddresses: true",
  );
});

test("configures kubectl with the rotating in-cluster service account token", async () => {
  const [dockerfile, kubeconfig] = await Promise.all([
    readFile(join(import.meta.dir, "image/server.Dockerfile"), "utf8"),
    readFile(join(import.meta.dir, "image/kubeconfig.yaml"), "utf8"),
  ]);

  expect(dockerfile).toContain("COPY deploy/image/kubeconfig.yaml /opt/pocketcoder/kubeconfig.yaml");
  expect(dockerfile).toContain("ENV KUBECONFIG=/opt/pocketcoder/kubeconfig.yaml");
  expect(kubeconfig).toContain("tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token");
  expect(kubeconfig).toContain("certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
});
