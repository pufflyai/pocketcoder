import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { monitoringImages } from "../../deploy/monitoring/config";
import { createHarnessWorkspace } from "./contract";
import { command, waitFor } from "./local-process";
import { managedDiagnostics } from "./managed-diagnostics";
import { managedLifecycleFixture } from "./managed-lifecycle-fixture";
import { monitoringFaults } from "./monitoring-faults";
import { monitoringFixture } from "./monitoring-fixture";
import { offNodeFixture } from "./off-node-fixture";

const storage = await offNodeFixture();
let fixture: Awaited<ReturnType<typeof managedLifecycleFixture>> | undefined;
let monitoring: Awaited<ReturnType<typeof monitoringFixture>> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let namespace: string | undefined;
try {
  await Promise.all(
    Object.values(monitoringImages).map((image) => command(["docker", "pull", image], { quiet: true })),
  );
  const f = await managedLifecycleFixture(storage.configure, { monitoring: true });
  fixture = f;
  const post = async (path: string, body?: unknown) => {
    const response = await f.request(path, {
      method: "POST",
      headers: { "idempotency-key": randomUUID() },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status !== 202) throw new Error(`Monitoring operation admission failed: ${response.status}`);
    return (await response.json()) as { account: { id: string; namespace: string }; operation: { id: string } };
  };
  const account = (await post("/v1/accounts", { name: "private-monitoring-account" })).account;
  const other = (await post("/v1/accounts", { name: "private-monitoring-peer" })).account;
  namespace = account.namespace;
  await f.reconcile();
  const owner = (await (
    await f.request(`/v1/accounts/${account.id}/owner`, {
      method: "POST",
      body: JSON.stringify({
        request_id: randomUUID(),
        expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
      }),
    })
  ).json()) as { token: string; key: { id: string; principal_id: string } };
  let url = await f.connect(account.namespace);
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json", ...init.headers },
    });
  const template = await f.cluster.echoTemplate(f.workspace.image);
  template.metadata.name = "private-monitoring-template";
  template.spec.resources.ephemeralStorage = "128Mi";
  if (!(await request("/v1/templates", { method: "POST", body: JSON.stringify({ manifest: template }) })).ok)
    throw new Error("Monitoring template import failed");
  async function backup(id: string) {
    const admitted = await post(`/v1/accounts/${id}/backups`);
    await waitFor(
      async () => {
        await f.reconcile();
        return (await f.currentStore()?.getOperation(admitted.operation.id))?.state === "succeeded";
      },
      60_000,
      "verified monitoring backup",
    );
  }
  await backup(account.id);
  await backup(other.id);
  await f.sampleMonitoring();
  const initial = await (await f.request("/metrics")).text();
  const available = initial
    .split("\n")
    .filter((line) => /^pocketcoder_(account_data|account_runtime|manager)_disk_available_bytes[ {]/.test(line))
    .map((line) => Number(line.split(" ").at(-1)));
  const minimum = Math.min(...available);
  if (!Number.isFinite(minimum) || minimum < 2 * 1024 ** 3 || !f.metricsToken)
    throw new Error("Owned pressure fixture lacks safe headroom or a finite metrics key");
  monitoring = await monitoringFixture({
    token: f.metricsToken,
    target: f.metricsTarget(),
    thresholds: {
      diskFraction: 0,
      diskBytes: minimum - 64 * 1024 ** 2,
      queueSeconds: 2,
      heartbeatSeconds: 20,
      cleanupSeconds: 3,
      backupSeconds: 60,
      journalSeconds: 10,
      credentialSeconds: 5,
    },
  });
  const m = monitoring;
  timer = setInterval(() => {
    void f.sampleMonitoring().catch(() => {});
  }, 1000);
  await waitFor(
    async () => (await m.query('up{job="pocketcoder-manager"}')) === 1,
    30_000,
    "authenticated real scraping",
  );
  const pressure = join(f.cluster.directory, "monitoring-pressure");
  await writeFile(pressure, Buffer.alloc(128 * 1024 ** 2));
  await f.cluster.kube([
    "-n",
    account.namespace,
    "exec",
    "deployment/controller",
    "-c",
    "controller",
    "--",
    "bun",
    "-e",
    "await Bun.write('/private/monitoring-pressure',Buffer.alloc(128*1024**2))",
  ]);
  await m.firing("disk");
  await rm(pressure);
  await f.cluster.kube([
    "-n",
    account.namespace,
    "exec",
    "deployment/controller",
    "-c",
    "controller",
    "--",
    "bun",
    "-e",
    "await (await import('node:fs/promises')).unlink('/private/monitoring-pressure')",
  ]);
  await m.resolved("disk");
  const active = [];
  for (let index = 0; index < 3; index++)
    active.push(await createHarnessWorkspace({ baseUrl: url, key: owner.token, template: template.metadata.name }));
  const queuedResponse = await request("/v1/workspaces", {
    method: "POST",
    headers: { "idempotency-key": randomUUID() },
    body: JSON.stringify({ external_id: randomUUID(), template: { name: template.metadata.name } }),
  });
  const queued = (await queuedResponse.json()) as { id: string; state: string };
  if (!queuedResponse.ok || queued.state !== "queued") throw new Error("Real scheduler queue pressure is missing");
  await m.firing("queue");
  await active[0]?.cancel();
  await m.resolved("queue");
  const latest = await (await f.request("/metrics")).text();
  for (const secret of [
    owner.token,
    f.metricsToken,
    template.metadata.name,
    "private-monitoring-account",
    ...active.map((workspace) => workspace.workspaceId),
    queued.id,
  ])
    if (latest.includes(secret)) throw new Error("Metrics contain restricted data");
  await monitoringFaults({
    f,
    m,
    account,
    other,
    request,
    workspace: active[1]?.workspaceId,
    backup,
    storageName: storage.storage.config.bucket,
    reconnect: async () => {
      url = await f.connect(account.namespace);
    },
    template: template.metadata.name,
    ownerToken: owner.token,
  });
  const expiring = await f.currentStore()?.createOperator(new Date(Date.now() + 15_000), "metrics");
  if (!expiring) throw new Error("Finite expiry fixture issuance failed");
  await m.rotateToken(expiring);
  await m.firing("credential");
  await m.firing("observation");
  await m.rotateToken(f.metricsToken);
  await m.resolved("credential");
  await m.resolved("observation");
  console.log(
    JSON.stringify({
      managedMonitoringPassed: true,
      alertFamilies: [
        "disk",
        "queue",
        "heartbeat",
        "cleanup",
        "backup",
        "journal",
        "observation",
        "capacity",
        "credential",
      ],
      operator: "au-re",
      environment: "owned local Kind, RustFS, Prometheus and Alertmanager",
      hostedAcceptance: false,
    }),
  );
} catch (error) {
  if (fixture && namespace) {
    console.error(await (await fixture.request("/metrics")).text());
    await managedDiagnostics(fixture, namespace);
  }
  throw error;
} finally {
  if (timer) clearInterval(timer);
  await monitoring?.close();
  await fixture?.close();
  await storage.close();
}
