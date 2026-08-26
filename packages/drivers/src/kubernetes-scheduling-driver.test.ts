import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const input = await Bun.stdin.text();
appendFileSync(${JSON.stringify(log)}, input + "\\n");
`,
    { mode: 0o755 },
  );
  if (process.platform === "win32") {
    await writeFile(bin, `@${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*\r\n`);
  }
  return { bin, log };
}

function launch(): WorkspaceLaunch {
  return {
    workspace: {
      id: randomUUID(),
      templateDigest: "sha256:template",
      templateSnapshot: {
        spec: {
          image: "registry.example/workspace@sha256:fixture",
          command: ["sleep", "3600"],
          env: {},
          resources: { cpu: "1", memory: "512Mi" },
          security: {
            uid: 10_001,
            gid: 10_001,
            writableMemoryPaths: [],
            readOnlyRoot: true,
            allowPrivilegeEscalation: false,
            dropCapabilities: ["ALL"],
            seccomp: "RuntimeDefault",
          },
          network: { mode: "unrestricted" },
        },
      },
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
  expect(job.spec.template.spec.tolerations).toEqual([
    { operator: "Exists", effect: "NoSchedule" },
  ]);
});
