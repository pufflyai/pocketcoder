import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("maps Kubernetes readiness and liveness to the matching endpoints", async () => {
  const manifest = await readFile(join(import.meta.dir, "kubernetes/pocketcoder.yaml"), "utf8");

  expect(manifest).toContain("readinessProbe:\n            httpGet:\n              path: /readyz");
  expect(manifest).toContain("livenessProbe:\n            httpGet:\n              path: /livez");
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

test("cross-builds patched Pi AgentAPI on the native build platform", async () => {
  const dockerfile = await readFile(join(import.meta.dir, "../examples/harnesses/pi/Dockerfile"), "utf8");

  expect(dockerfile).toContain("FROM --platform=$BUILDPLATFORM golang:");
  expect(dockerfile).toContain("ADD --checksum=sha256:");
  expect(dockerfile).toContain("patch -p1 < /tmp/agentapi-identical-replies.patch");
  expect(dockerfile).toContain("CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build");
  expect(dockerfile).not.toContain("await fetch(process.argv[1])");
});
