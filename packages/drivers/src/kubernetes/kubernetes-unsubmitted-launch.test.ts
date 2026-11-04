import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { ProviderNotSubmittedError, type WorkspaceLaunch } from "@pstdio/pocketcoder-runtime-core";
import { KubernetesDriver } from "./kubernetes";
import { KubernetesSharedStorage } from "./kubernetes-shared-storage";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// kubectl is the provider boundary: it answers with one shared claim and volume and records every call.
async function fakeKubectl(directory: string, nfsServer: string) {
  const calls = join(directory, "calls.ndjson");
  const script = join(directory, "kubectl.ts");
  const bin = process.platform === "win32" ? join(directory, "kubectl.cmd") : script;
  const bound = {
    status: { phase: "Bound" },
    spec: { storageClassName: "qualified-nfs", accessModes: ["ReadWriteMany"] },
  };
  const claim = {
    metadata: { name: "shared", uid: "claim" },
    ...bound,
    spec: { ...bound.spec, volumeName: "shared-pv" },
  };
  const volume = {
    metadata: { name: "shared-pv", uid: "volume" },
    ...bound,
    spec: {
      ...bound.spec,
      persistentVolumeReclaimPolicy: "Retain",
      claimRef: { uid: "claim", namespace: "workspaces", name: "shared" },
      nfs: { server: nfsServer },
    },
  };
  const policies = {
    items: [
      {
        metadata: { name: "storage-isolation" },
        spec: {
          podSelector: {},
          policyTypes: ["Egress"],
          egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.1.5.20/32"] } }] }],
        },
      },
    ],
  };
  await writeFile(
    script,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const kind = args[args.indexOf("get") + 1];
if (args.includes("get") && kind === "pvc") console.log(${JSON.stringify(JSON.stringify(claim))});
if (args.includes("get") && kind === "pv") console.log(${JSON.stringify(JSON.stringify(volume))});
if (args.includes("get") && kind === "networkpolicies") console.log(${JSON.stringify(JSON.stringify(policies))});
if (args.includes("create")) console.log(JSON.stringify({ metadata: { uid: "secret-uid", resourceVersion: "1" } }));
`,
    { mode: 0o755 },
  );
  if (process.platform === "win32")
    await writeFile(bin, `@${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*\r\n`);
  return {
    bin,
    calls: async () =>
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

function launch(): WorkspaceLaunch {
  const parsed = parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "unsubmitted-fixture" },
    spec: {
      version: "1.0.0",
      image: `registry.example/workspace@sha256:${"a".repeat(64)}`,
      command: ["sleep", "3600"],
      harness: { command: ["sleep", "3600"] },
      resources: { cpu: "1", memory: "512Mi" },
      security: { writableMemoryPaths: [] },
    },
  });
  return {
    workspace: { id: randomUUID(), templateDigest: parsed.digest, templateSnapshot: snapshotOf(parsed) },
    input: {},
    mounts: [],
    secrets: [],
  } as unknown as WorkspaceLaunch;
}

const refusals = [
  {
    name: "an NFS endpoint outside the declared storage range",
    nfsServer: "10.9.9.9",
    usableRoot: true,
    reason: /NFS endpoint is not isolated from workloads/,
  },
  {
    name: "a shared storage root the controller cannot use",
    nfsServer: "10.1.5.20",
    usableRoot: false,
    reason: /Shared input storage is unavailable .*ENOTDIR/,
  },
];

async function sharedDriver(nfsServer: string, usableRoot: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "pc-unsubmitted-"));
  directories.push(directory);
  const root = join(directory, "shared");
  // A file where the storage root should be makes every directory operation under it fail.
  if (!usableRoot) await writeFile(root, "");
  const kubectl = await fakeKubectl(directory, nfsServer);
  const driver = new KubernetesDriver({
    namespace: "workspaces",
    kubectlBin: kubectl.bin,
    sharedStorage: new KubernetesSharedStorage({
      root,
      checkpointRoot: join(directory, "checkpoints"),
      claimName: "shared",
      volumeName: "shared-pv",
      storageClassName: "qualified-nfs",
      networkPolicyName: "storage-isolation",
      storageCidrs: ["10.1.5.20/32"],
      profile: "shared-writer-readonly/v1",
      maxBytes: 1024,
      maxFiles: 8,
    }),
  });
  return { driver, kubectl };
}

test.each(refusals)(
  "a launch refused by $name submits nothing and says why",
  async ({ nfsServer, usableRoot, reason }) => {
    const { driver, kubectl } = await sharedDriver(nfsServer, usableRoot);
    const launched = driver.create(launch());
    await expect(launched).rejects.toBeInstanceOf(ProviderNotSubmittedError);
    await expect(launched).rejects.toThrow(reason);
    expect((await kubectl.calls()).filter((args: string[]) => args.includes("create"))).toEqual([]);
  },
);

test.each(refusals)(
  "the shared storage check reports $name before any launch",
  async ({ nfsServer, usableRoot, reason }) => {
    const { driver } = await sharedDriver(nfsServer, usableRoot);
    await expect(driver.checkSharedStorage()).rejects.toThrow(reason);
  },
);

test("the shared storage check passes for usable, isolated storage", async () => {
  const { driver } = await sharedDriver("10.1.5.20", true);
  await driver.checkSharedStorage();
});
