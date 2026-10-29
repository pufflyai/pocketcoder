// PC-149: install the upstream chart with values only (PostgreSQL URL, keys, storage) on a
// local kind cluster, then run an echo workspace through the installed controller.
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createKubernetesCluster, ROOT } from "./kubernetes-cluster";
import { waitFor } from "./local-process";

const namespace = "pc-helm";
const cluster = await createKubernetesCluster();
let forward: ReturnType<typeof Bun.spawn> | undefined;
try {
  const [server, workspace] = await Promise.all([cluster.buildImage("server"), cluster.buildImage("workspace")]);
  await cluster.kube(["create", "namespace", namespace]);
  const databaseUrl = `postgres://pocketcoder:pocketcoder@postgres.${namespace}.svc:5432/pocketcoder`;
  await cluster.kube(
    ["-n", namespace, "apply", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "postgres" },
          spec: {
            selector: { matchLabels: { app: "postgres" } },
            template: {
              metadata: { labels: { app: "postgres" } },
              spec: {
                containers: [
                  {
                    name: "postgres",
                    // Pulled by the nodes: kind cannot load multi-platform images.
                    image: "postgres:18-alpine",
                    env: [
                      { name: "POSTGRES_USER", value: "pocketcoder" },
                      { name: "POSTGRES_PASSWORD", value: "pocketcoder" },
                      { name: "POSTGRES_DB", value: "pocketcoder" },
                    ],
                    ports: [{ containerPort: 5432 }],
                    readinessProbe: { exec: { command: ["pg_isready", "-U", "pocketcoder"] } },
                  },
                ],
              },
            },
          },
        },
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: "postgres" },
          spec: { selector: { app: "postgres" }, ports: [{ port: 5432 }] },
        },
        {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: "pocketcoder-database" },
          stringData: { "database-url": databaseUrl },
        },
        {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: "pocketcoder-keys" },
          stringData: { "auth-pepper": randomBytes(32).toString("base64url") },
        },
      ],
    }),
  );
  await cluster.kube(["-n", namespace, "rollout", "status", "deployment/postgres", "--timeout=120s"]);

  const [repository, digest] = server.image.split("@") as [string, string];
  const template = await cluster.echoTemplate(workspace.image);
  const values = {
    image: { repository, digest },
    store: { database: { urlSecret: { name: "pocketcoder-database" } } },
    keys: { secretName: "pocketcoder-keys" },
    workspace: { runtimeClassName: "pc-runc" },
    templates: { files: { "echo.json": template } },
  };
  const valuesFile = join(cluster.directory, "values.json");
  await Bun.write(valuesFile, JSON.stringify(values));
  await cluster.run([
    "helm",
    "install",
    "pc",
    join(ROOT, "deploy/helm/pocketcoder"),
    "--namespace",
    namespace,
    "-f",
    valuesFile,
    "--wait",
    "--timeout",
    "180s",
  ]);
  console.log("Chart installed: controller ready on PostgreSQL");
  const logs = await cluster.kube(["-n", namespace, "logs", "deployment/pocketcoder-server", "-c", "server"]);
  if (!logs.includes("store: postgres (schema pocketcoder)"))
    throw new Error(`controller is not on PostgreSQL:\n${logs}`);
  const migrate = await cluster.kube(["-n", namespace, "logs", "deployment/pocketcoder-server", "-c", "migrate"]);
  console.log(`Migration step: ${migrate.split("\n")[0]}`);

  const owner = JSON.parse(
    await cluster.kube([
      "-n",
      namespace,
      "exec",
      "deployment/pocketcoder-server",
      "-c",
      "server",
      "--",
      "pcd",
      "superuser",
      "create",
      "--dir",
      "/var/lib/pocketcoder/data",
      "--automation",
      "--expires",
      new Date(Date.now() + 600_000).toISOString(),
      "--request-id",
      randomUUID(),
      "--json",
    ]),
  ) as { token: string };
  forward = Bun.spawn(["kubectl", "-n", namespace, "port-forward", "service/pocketcoder-server", ":7080"], {
    env: { ...process.env, ...cluster.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = (forward.stdout as ReadableStream<Uint8Array>).getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const port = /127\.0\.0\.1:(\d+)/.exec(first)?.[1];
  if (!port) throw new Error(`port-forward failed: ${first}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.token}`, ...init.headers },
    });
  const created = await request("/v1/workspaces", {
    method: "POST",
    headers: { "idempotency-key": "helm-echo" },
    body: JSON.stringify({ external_id: "helm-echo", template: { name: template.metadata.name } }),
  });
  if (created.status !== 201 && created.status !== 202)
    throw new Error(`workspace create failed: ${created.status} ${await created.text()}`);
  const { id } = (await created.json()) as { id: string };
  let state = "";
  await waitFor(
    async () => {
      state = ((await (await request(`/v1/workspaces/${id}`)).json()) as { state: string }).state;
      if (["failed", "canceled", "ended"].includes(state)) throw new Error(`workspace ended early: ${state}`);
      return state === "ready";
    },
    180_000,
    "echo workspace readiness",
  );
  console.log(`Echo workspace ${id} is ready through the Helm-installed controller`);
  await request(`/v1/workspaces/${id}/cancel`, { method: "POST" });
} finally {
  forward?.kill();
  await cluster.close();
}
