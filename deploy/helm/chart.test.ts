import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chart = join(import.meta.dir, "pocketcoder");
const helm = Bun.which("helm");
const digest = `sha256:${"a".repeat(64)}`;

interface Resource {
  kind: string;
  metadata: { name: string };
  spec?: Record<string, unknown>;
}

async function render(values: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "pc-chart-"));
  try {
    const file = join(directory, "values.json");
    await writeFile(file, JSON.stringify(values));
    const child = Bun.spawn([helm as string, "template", "pc", chart, "--namespace", "runtime", "-f", file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(stderr);
    const documents = Bun.YAML.parse(stdout) as Resource | (Resource | null)[];
    return (Array.isArray(documents) ? documents : [documents]).filter(
      (resource): resource is Resource => resource !== null,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const postgres = {
  image: { repository: "ghcr.io/pufflyai/pocketcoder/server", digest },
  store: { database: { urlSecret: { name: "pocketcoder-database" } } },
  keys: { secretName: "pocketcoder-keys" },
};

function find(resources: Resource[], kind: string, name: string) {
  const resource = resources.find((item) => item.kind === kind && item.metadata.name === name);
  if (!resource) throw new Error(`${kind}/${name} missing`);
  return resource;
}

type Container = { name: string; command?: string[]; env: { name: string; value?: string; valueFrom?: unknown }[] };

function pod(resources: Resource[]) {
  const deployment = find(resources, "Deployment", "pocketcoder-server") as {
    spec: { template: { spec: { initContainers?: Container[]; containers: Container[] } } };
  };
  return deployment.spec.template.spec;
}

function env(container: Container | undefined) {
  return Object.fromEntries((container?.env ?? []).map((entry) => [entry.name, entry.value ?? entry.valueFrom]));
}

describe.skipIf(!helm)("Helm chart", () => {
  test("PostgreSQL by default: secrets for the URL and pepper, migration before start", async () => {
    const resources = await render(postgres);
    const spec = pod(resources);
    expect(spec.initContainers?.map((container) => container.command)).toEqual([["pcd", "db", "migrate"]]);
    const server = env(spec.containers[0]);
    expect(server).toMatchObject({
      POCKETCODER_STORE: "postgres",
      POCKETCODER_DATABASE_URL: { secretKeyRef: { name: "pocketcoder-database", key: "database-url" } },
      POCKETCODER_AUTH_PEPPER: { secretKeyRef: { name: "pocketcoder-keys", key: "auth-pepper" } },
      POCKETCODER_JOURNAL_DIR: "/var/lib/pocketcoder-journal/journal",
      POCKETCODER_DRIVER: "kubernetes",
      POCKETCODER_WORKSPACE_SERVER_URL: "http://pocketcoder-agent.runtime.svc:7081",
    });
    expect(env(spec.initContainers?.[0])).toMatchObject({ POCKETCODER_DATABASE_SCHEMA: "pocketcoder" });
    for (const name of ["pocketcoder-server-live", "pocketcoder-agent"])
      expect(find(resources, "Service", name).spec).toMatchObject({ publishNotReadyAddresses: true });
    expect(find(resources, "Service", "pocketcoder-server").spec).not.toHaveProperty("publishNotReadyAddresses");
    find(resources, "PersistentVolumeClaim", "pc-data");
    find(resources, "PersistentVolumeClaim", "pc-journal");
  });

  test("PGlite keeps the embedded store without a migration step", async () => {
    const spec = pod(await render({ ...postgres, store: { kind: "pglite" } }));
    expect(spec.initContainers).toBeUndefined();
    expect(env(spec.containers[0])).toMatchObject({ POCKETCODER_STORE: "pglite" });
    expect(env(spec.containers[0])).not.toHaveProperty("POCKETCODER_DATABASE_URL");
  });

  test.each([
    [{ ...postgres, image: { repository: "ghcr.io/x/server", digest: "" } }, "image.digest must pin"],
    [{ ...postgres, store: { database: { urlSecret: { name: "" } } } }, "urlSecret.name is required"],
    [{ ...postgres, keys: { secretName: "" } }, "keys.secretName is required"],
  ])("refuses incomplete values", async (values, message) => {
    await expect(render(values)).rejects.toThrow(message);
  });

  // An Onefin-shaped install: values plus its accounting sidecar, no forked templates.
  test("consumers extend the chart with values only", async () => {
    const resources = await render({
      ...postgres,
      store: {
        database: { urlSecret: { name: "pocketcoder-database" }, caConfigMap: { name: "rds-ca", key: "bundle.pem" } },
      },
      workspace: {
        namespace: "agent-workspaces",
        runtimeClassName: "agent-runc",
        nodeSelector: { workload: "agent-workspace" },
        tolerations: [{ key: "workload", operator: "Equal", value: "agent-workspace", effect: "NoSchedule" }],
      },
      principals: {
        config: { principals: [{ name: "backend", scopes: ["workspaces:create"], templates: ["agent-task"] }] },
      },
      launchPolicy: { url: "http://127.0.0.1:9001/v1/admission", tokenSecret: { name: "accounting" } },
      sidecars: [{ name: "accounting", image: "registry.example/accounting@sha256:abc" }],
      extraEnv: [{ name: "EXTRA", value: "1" }],
      networkPolicy: { enabled: true },
    });
    const spec = pod(resources);
    expect(spec.containers.map((container) => container.name)).toEqual(["server", "accounting"]);
    expect(env(spec.containers[0])).toMatchObject({
      NODE_EXTRA_CA_CERTS: "/etc/pocketcoder/database-ca/bundle.pem",
      POCKETCODER_KUBERNETES_NAMESPACE: "agent-workspaces",
      POCKETCODER_KUBERNETES_RUNTIME_CLASS: "agent-runc",
      POCKETCODER_KUBERNETES_NODE_SELECTOR: '{"workload":"agent-workspace"}',
      POCKETCODER_PRINCIPALS_FILE: "/etc/pocketcoder/principals/principals.json",
      POCKETCODER_LAUNCH_POLICY_URL: "http://127.0.0.1:9001/v1/admission",
      EXTRA: "1",
    });
    expect(find(resources, "Role", "pc-controller").metadata).toMatchObject({ namespace: "agent-workspaces" });
    find(resources, "ConfigMap", "pc-principals");
    find(resources, "NetworkPolicy", "pc-controller");
  });
});
