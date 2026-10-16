import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceLaunch } from "@pstdio/pocketcoder-runtime-core";
import { KubernetesDriver } from "./kubernetes";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

async function fakeKubectl() {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "pocketcoder-kubectl-scheduling-"));
  const log = join(temporaryDirectory, "calls.ndjson");
  const script = join(temporaryDirectory, "kubectl.ts");
  const bin = process.platform === "win32" ? join(temporaryDirectory, "kubectl.cmd") : script;
  await writeFile(
    script,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const input = (args.includes("create") || args.includes("apply")) ? await Bun.stdin.text() : "";
if (input) appendFileSync(${JSON.stringify(log)}, input + "\\n");
if (args.includes("create")) console.log(JSON.stringify({ metadata: { uid: "secret-uid", resourceVersion: "1" } }));
`,
    { mode: 0o755 },
  );
  if (process.platform === "win32") {
    await writeFile(bin, `@${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*\r\n`);
  }
  return { bin, log };
}

function launch(): WorkspaceLaunch {
  const parsed = parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "scheduling-fixture" },
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
    workspace: {
      id: randomUUID(),
      templateDigest: parsed.digest,
      templateSnapshot: snapshotOf(parsed),
    },
    input: {},
    mounts: [],
    secrets: [],
  } as unknown as WorkspaceLaunch;
}

test("forwards scheduling options to the applied Job", async () => {
  const fake = await fakeKubectl();
  const driver = new KubernetesDriver({
    kubectlBin: fake.bin,
    nodeSelector: { dedicated: "workspace" },
    tolerations: [{ operator: "Exists", effect: "NoSchedule" }],
  });

  await driver.create(launch());
  const manifests = (await readFile(fake.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const job = manifests.find((manifest) => manifest.kind === "Job") as {
    spec: { template: { spec: Record<string, unknown> } };
  };

  expect(job.spec.template.spec.nodeSelector).toEqual({ dedicated: "workspace" });
  expect(job.spec.template.spec.tolerations).toEqual([{ operator: "Exists", effect: "NoSchedule" }]);
});
