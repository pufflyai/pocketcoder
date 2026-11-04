import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { DatabaseStore } from "@pstdio/pocketcoder-db";
import { DEFAULT_LIMITS, Scheduler } from "@pstdio/pocketcoder-runtime-core";
import { KubernetesDriver } from "./kubernetes";
import { resourceName } from "./kubernetes-command";
import { KUBERNETES_WORKSPACE_LABEL } from "./kubernetes-labels";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

// kubectl is the provider boundary: the namespace holds only the listed Secrets.
async function fakeKubectl(secrets: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "pc-stuck-cleanup-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "kubectl.ts");
  const bin = process.platform === "win32" ? join(directory, "kubectl.cmd") : script;
  await writeFile(
    script,
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.includes("get") && args.includes("-l")) {
  const kind = args[args.indexOf("get") + 1];
  console.log(JSON.stringify({ items: kind === "secrets" ? ${JSON.stringify(secrets)} : [] }));
}
`,
    { mode: 0o755 },
  );
  if (process.platform === "win32")
    await writeFile(bin, `@${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*\r\n`);
  return bin;
}

// The row an earlier controller left: a launch that failed before its receipt, failed at registration
// expiry, and stayed terminating because cleanup could not prove the provider absent.
async function stuckLaunch(store: DatabaseStore, at: Date) {
  const parsed = parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "stuck-fixture" },
    spec: {
      version: "1.0.0",
      image: `registry.example/workspace@sha256:${"a".repeat(64)}`,
      command: ["sleep", "3600"],
      harness: { command: ["sleep", "3600"] },
      resources: { cpu: "1", memory: "512Mi" },
      security: { writableMemoryPaths: [] },
    },
  });
  const snapshot = snapshotOf(parsed);
  const principal = await store.createPrincipal("owner", ["admin"], ["*"]);
  const { row: template } = await store.upsertTemplate({
    name: snapshot.name,
    version: snapshot.version,
    digest: snapshot.digest,
    spec: snapshot.spec,
    description: null,
  });
  const id = randomUUID();
  await store.insertWorkspace({
    id,
    principalId: principal.id,
    externalId: id,
    idempotencyKey: id,
    requestDigest: snapshot.digest,
    templateId: template.id,
    templateSnapshot: snapshot,
    launchInput: null,
    metadata: {},
    deadlineAt: new Date(at.getTime() + 3_600_000),
    createdAt: at,
  });
  await store.transition(id, {
    from: ["queued"],
    to: "provisioning",
    at,
    patch: { registrationExpiresAt: new Date(at.getTime() + 60_000) },
  });
  await store.transition(id, {
    from: ["provisioning"],
    to: "terminating",
    reason: "registration_timeout",
    at: new Date(at.getTime() + 60_000),
    patch: { terminalIntent: "failed", registrationDigest: null },
  });
  return id;
}

async function restartedController(secrets: (workspaceId: string) => unknown[]) {
  const store = await DatabaseStore.openPGlite();
  cleanups.push(() => store.close());
  const started = new Date("2026-11-04T00:22:00Z");
  const id = await stuckLaunch(store, started);
  const scheduler = new Scheduler({
    store,
    driver: new KubernetesDriver({ namespace: "workspaces", kubectlBin: await fakeKubectl(secrets(id)) }),
    now: () => new Date(started.getTime() + 3_600_000),
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:8091",
    secrets: { generate: () => randomUUID(), digest: (value) => Buffer.from(value) },
    connections: { isConnected: () => false, shutdown: () => false, signal: () => false, close: () => {} },
  });
  await scheduler.tick();
  return store.getWorkspace(id);
}

test("a launch an earlier controller left terminating settles when no provider object exists", async () => {
  const workspace = await restartedController(() => []);
  expect(workspace?.state).toBe("failed");
  expect(workspace?.terminalAt).not.toBeNull();
});

test("a launch with a leftover workspace object still waits for proof", async () => {
  const workspace = await restartedController((id) => [
    { metadata: { name: `${resourceName(id)}-registry`, labels: { [KUBERNETES_WORKSPACE_LABEL]: id } } },
  ]);
  expect(workspace?.state).toBe("terminating");
});
