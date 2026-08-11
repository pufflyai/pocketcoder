import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("maps Kubernetes readiness and liveness to the matching endpoints", async () => {
  const manifest = await readFile(join(import.meta.dir, "kubernetes/pocketcoder.yaml"), "utf8");

  expect(manifest).toContain("readinessProbe:\n            httpGet:\n              path: /readyz");
  expect(manifest).toContain("livenessProbe:\n            httpGet:\n              path: /livez");
});

test("ships database migrations beside the bundled server and pcd entry points", async () => {
  const dockerfile = await readFile(join(import.meta.dir, "image/server.Dockerfile"), "utf8");

  expect(dockerfile).toContain(
    "COPY --from=build /src/packages/db/drizzle /opt/pocketcoder/drizzle",
  );
  expect(dockerfile).toContain(
    "RUN test -f /opt/pocketcoder/drizzle/20260730103433_initial/migration.sql",
  );
  expect(dockerfile.split("\n")).toContain("WORKDIR /");
});

test("configures kubectl with the rotating in-cluster service account token", async () => {
  const [dockerfile, kubeconfig] = await Promise.all([
    readFile(join(import.meta.dir, "image/server.Dockerfile"), "utf8"),
    readFile(join(import.meta.dir, "image/kubeconfig.yaml"), "utf8"),
  ]);

  expect(dockerfile).toContain(
    "COPY deploy/image/kubeconfig.yaml /opt/pocketcoder/kubeconfig.yaml",
  );
  expect(dockerfile).toContain("ENV KUBECONFIG=/opt/pocketcoder/kubeconfig.yaml");
  expect(kubeconfig).toContain("tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token");
  expect(kubeconfig).toContain(
    "certificate-authority: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  );
});

test("downloads Pi AgentAPI binaries without running emulated Bun", async () => {
  const dockerfile = await readFile(
    join(import.meta.dir, "../examples/harnesses/pi/Dockerfile"),
    "utf8",
  );

  expect(dockerfile).toContain("FROM scratch AS agentapi-amd64");
  expect(dockerfile).toContain("FROM scratch AS agentapi-arm64");
  expect(dockerfile).toContain("ADD --checksum=sha256:");
  expect(dockerfile).not.toContain("await fetch(process.argv[1])");
});
