// An owned Kind cluster qualifies parallel first placement, group draining and cleanup.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { imageSessionTemplate } from "../local/session-template";
import { createKubernetesCluster } from "./kubernetes-cluster";
import { controllerKubeconfig } from "./kubernetes-controller-rbac";
import { startSharedNfs } from "./kubernetes-shared-nfs";
import { waitFor } from "./local-process";

const cluster = await createKubernetesCluster();
const namespace = "pc-managed-sessions";
let shared: Awaited<ReturnType<typeof startSharedNfs>> | undefined;
let forward: ReturnType<typeof Bun.spawn> | undefined;
try {
  const server = await cluster.buildImage("server", { hostBundled: true });
  const workspace = await cluster.buildImage("workspace");
  const template = await imageSessionTemplate(`${workspace.tag}@${workspace.imageId}`, "kind-managed-echo");
  template.spec.image = workspace.image;
  template.spec.resources = { cpu: "100m", memory: "256Mi" };
  await cluster.kube(["create", "namespace", namespace]);
  await controllerKubeconfig(cluster, namespace);
  shared = await startSharedNfs(cluster, namespace);
  const principals = {
    principals: [
      {
        name: "consumer",
        scopes: ["sessions:read", "sessions:write"],
        templates: [template.metadata.name],
        key: { target: { kind: "kubernetes-secret", namespace, name: "consumer-key", key: "token" } },
        profiles: {
          chat: {
            template: template.metadata.name,
            placement: "shared",
            limits: { workspacesPerOwner: 1, sessionsPerWorkspace: 5 },
          },
        },
      },
    ],
  };
  const env = {
    POCKETCODER_DIR: "/tmp/controller/data",
    POCKETCODER_WORKLOAD_LIMITS: JSON.stringify(template.spec.limits),
    POCKETCODER_AUTH_PEPPER: randomBytes(32).toString("base64url"),
    POCKETCODER_DRIVER: "kubernetes",
    POCKETCODER_KUBERNETES_NAMESPACE: namespace,
    POCKETCODER_KUBERNETES_RUNTIME_CLASS: "pc-runc",
    POCKETCODER_STORAGE_BACKEND: "kubernetes-shared",
    POCKETCODER_CHECKPOINT_DIR: "/tmp/controller/checkpoints",
    POCKETCODER_KUBERNETES_SHARED_STORAGE: JSON.stringify({
      ...shared.options,
      root: "/data/shared",
      maxBytes: 33_554_432,
      maxFiles: 256,
    }),
    POCKETCODER_INPUT_STORAGE: JSON.stringify({
      root: "/tmp/controller/inputs",
      limits: {
        fileBytes: 1_048_576,
        stagedBytes: 8_388_608,
        files: 16,
        transfers: 2,
        transferMs: 30_000,
        retentionMs: 600_000,
      },
      principal: { bytes: 16_777_216, files: 32 },
      instance: { bytes: 33_554_432, files: 64 },
      headroom: { bytes: 1, files: 1 },
    }),
    POCKETCODER_HTTP: "0.0.0.0:7080",
    POCKETCODER_AGENT_HTTP: "0.0.0.0:7081",
    POCKETCODER_WORKSPACE_SERVER_URL: `http://controller.${namespace}.svc:7081`,
    POCKETCODER_TEMPLATE_DIR: "/etc/pocketcoder/templates",
    POCKETCODER_PRINCIPALS_FILE: "/etc/pocketcoder/principals.json",
  };
  await cluster.kube(
    ["-n", namespace, "apply", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: "managed-config" },
          data: { "principals.json": JSON.stringify(principals), "echo.json": JSON.stringify(template) },
        },
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: "controller" },
          spec: {
            selector: { app: "controller" },
            ports: [
              { name: "api", port: 7080 },
              { name: "agent", port: 7081 },
            ],
          },
        },
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "controller" },
          spec: {
            selector: { matchLabels: { app: "controller" } },
            template: {
              metadata: { labels: { app: "controller" } },
              spec: {
                serviceAccountName: "pocketcoder-controller",
                containers: [
                  {
                    name: "controller",
                    image: server.image,
                    imagePullPolicy: "IfNotPresent",
                    env: Object.entries(env).map(([name, value]) => ({ name, value })),
                    volumeMounts: [
                      { name: "shared", mountPath: "/data/shared" },
                      { name: "config", mountPath: "/etc/pocketcoder/principals.json", subPath: "principals.json" },
                      { name: "config", mountPath: "/etc/pocketcoder/templates/echo.json", subPath: "echo.json" },
                    ],
                  },
                ],
                volumes: [
                  { name: "shared", persistentVolumeClaim: { claimName: shared.options.claimName } },
                  { name: "config", configMap: { name: "managed-config" } },
                ],
              },
            },
          },
        },
      ],
    }),
  );
  await cluster.kube(["-n", namespace, "rollout", "status", "deployment/controller", "--timeout=120s"]);
  let token = "";
  await waitFor(
    async () => {
      const secret = await cluster
        .kube(["-n", namespace, "get", "secret", "consumer-key", "-o", "json"])
        .catch(() => "");
      if (!secret) return false;
      token = Buffer.from(JSON.parse(secret).data.token, "base64").toString();
      return Boolean(token);
    },
    120_000,
    "managed consumer key",
  );
  forward = Bun.spawn(["kubectl", "-n", namespace, "port-forward", "service/controller", ":7080"], {
    env: { ...process.env, ...cluster.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = (forward.stdout as ReadableStream<Uint8Array>).getReader();
  const line = new TextDecoder().decode((await reader.read()).value);
  const port = /127\.0\.0\.1:(\d+)/.exec(line)?.[1];
  assert(port, line);
  const client = new PocketCoderClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: token });
  const sessions = await Promise.all(
    Array.from({ length: 5 }, () =>
      client.sessions.create({ sessionId: randomUUID(), profile: "chat", owner: "user", group: "first" }),
    ),
  );
  const turns = await Promise.all(
    sessions.map((s) =>
      client.requests.submit(s.sessionId, { requestId: randomUUID(), message: "hello from Kind", attachments: [] }),
    ),
  );
  await waitFor(
    async () => {
      const states = await Promise.all(turns.map((r) => client.requests.get(r.sessionId, r.requestId)));
      const failed = states.find((r) => r.state === "terminal" && r.outcome !== "completed");
      assert(!failed, JSON.stringify(failed));
      return states.every((r) => r.outcome === "completed");
    },
    180_000,
    "five managed turns",
  );
  const pods = async () =>
    JSON.parse(await cluster.kube(["-n", namespace, "get", "pods", "-l", "pocketcoder.workspace", "-o", "json"]))
      .items as { metadata: { uid: string } }[];
  const original = await pods();
  assert.equal(original.length, 1, "parallel sessions must share their first workspace");
  const other = await client.sessions.create({
    sessionId: randomUUID(),
    profile: "chat",
    owner: "user",
    group: "second",
  });
  const request = await client.requests.submit(other.sessionId, {
    requestId: randomUUID(),
    message: "make room for another group",
    attachments: [],
  });
  await waitFor(
    async () => (await client.requests.get(other.sessionId, request.requestId)).outcome === "completed",
    180_000,
    "group replacement turn",
  );
  await waitFor(
    async () => {
      const current = await pods();
      return current.length === 1 && current[0]?.metadata.uid !== original[0]?.metadata.uid;
    },
    120_000,
    "drained workspace removal",
  );
  await Promise.all([...sessions, other].map((s) => client.sessions.close(s.sessionId)));
  await waitFor(async () => (await pods()).length === 0, 120_000, "managed workspace cleanup");
  console.log(
    "Kind managed sessions passed: five concurrent turns share one workspace; another group drains it; close removes compute.",
  );
} finally {
  forward?.kill();
  try {
    await cluster.close();
  } finally {
    await shared?.close();
  }
}
