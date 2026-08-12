import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PoolProviderInput,
  type ProviderInput,
  parseTemplateManifest,
  snapshotOf,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { DockerDriver, resolveDockerImage } from "./docker";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function dockerMock(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-docker-test-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "docker");
  await writeFile(executable, `#!/usr/bin/env bun\n${source}`, { mode: 0o755 });
  return executable;
}

describe("Docker image resolution", () => {
  test("creates task-agnostic warm containers with pool-only input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketcoder-docker-warm-"));
    temporaryDirectories.push(directory);
    const log = join(directory, "args.json");
    const docker = await dockerMock(`
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "image") console.log(args[2]);
else if (args[0] === "run") { writeFileSync(${JSON.stringify(log)}, JSON.stringify(args)); console.log("warm-id"); }
`);
    const parsed = parseTemplateManifest({
      apiVersion: "pocketcoder.dev/v1alpha1",
      kind: "Template",
      metadata: { name: "warm-docker" },
      spec: {
        version: "1.0.0",
        image: `registry.example/warm@sha256:${"c".repeat(64)}`,
        harness: { command: ["/bin/true"] },
        resources: { cpu: "1", memory: "256Mi" },
      },
    });
    const runtimeId = randomUUID();
    const input: PoolProviderInput = {
      pool_runtime_id: runtimeId,
      server_url: "http://host.docker.internal:7080",
      enrollment_secret: "pool-only",
      template_digest: parsed.digest,
      template_name: "warm-docker",
      template_version: "1.0.0",
    };
    const inputDir = join(directory, "input");
    const driver = new DockerDriver({ dockerBin: docker, inputDir });
    await driver.createWarm({
      runtimeId,
      template: snapshotOf(parsed),
      input,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const persisted = JSON.parse(await readFile(join(inputDir, `pool-${runtimeId}.json`), "utf8"));
    expect(persisted).toEqual(input);
    expect(persisted.workspace_id).toBeUndefined();
    expect(persisted.launch_input).toBeUndefined();
    const args = JSON.parse(await readFile(log, "utf8")) as string[];
    expect(args).toContain(`pocketcoder.pool-runtime=${runtimeId}`);
    expect(args.join(" ")).not.toContain("pocketcoder.workspace=");
  });
  test("uses an exact local image ID for a locally built digest reference", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const docker = await dockerMock(`
const args = process.argv.slice(2);
if (args.join(" ") !== "image inspect ${digest} --format {{.Id}}") process.exit(2);
console.log("${digest}");
`);

    expect(await resolveDockerImage(docker, `pocketcoder-example:test@${digest}`)).toBe(digest);
  });

  test("keeps a repository digest when it is not a local image ID", async () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const image = `registry.example/workspace@${digest}`;
    const docker = await dockerMock("process.exit(1);");

    expect(await resolveDockerImage(docker, image)).toBe(image);
  });

  test("mounts opaque local storage and deployment secret files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketcoder-docker-launch-"));
    temporaryDirectories.push(directory);
    const log = join(directory, "args.json");
    const docker = await dockerMock(`
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "image") {
  console.log(args[2]);
} else if (args[0] === "run") {
  writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
  console.log("container-id");
}
`);
    const parsed = parseTemplateManifest({
      apiVersion: "pocketcoder.dev/v1alpha1",
      kind: "Template",
      metadata: { name: "docker-persistent" },
      spec: {
        version: "1.0.0",
        image: `registry.example/workspace@sha256:${"a".repeat(64)}`,
        harness: { command: ["/bin/true"] },
        env: {
          SAFE_VALUE: "yes",
          MODEL_KEY_FILE: "secretRef:model/key",
        },
        resources: { cpu: "1", memory: "256Mi" },
        security: {
          uid: 12_345,
          gid: 23_456,
          writableMemoryPaths: ["/tmp", "/home/onefin"],
        },
      },
    });
    const workspaceId = randomUUID();
    const workspace = {
      id: workspaceId,
      templateDigest: parsed.digest,
      templateSnapshot: snapshotOf(parsed),
    } as WorkspaceRow;
    const input: ProviderInput = {
      workspace_id: workspaceId,
      server_url: "http://host.docker.internal:7080",
      registration_secret: "one-time",
      template_digest: parsed.digest,
      template_name: "docker-persistent",
      template_version: "1.0.0",
      launch_mode: "create",
    };
    const driver = new DockerDriver({
      dockerBin: docker,
      inputDir: join(directory, "input"),
    });
    await driver.create({
      workspace,
      input,
      mounts: [
        {
          name: "worktree",
          target: "/workspace",
          source: {
            kind: "host-path",
            path: join(directory, "workspaces", workspaceId),
          },
        },
      ],
      secrets: [
        {
          name: "model-key",
          target: "/run/pocketcoder/secrets/model%2Fkey",
          source: {
            kind: "host-path",
            path: join(directory, "secrets", "model-key"),
          },
        },
      ],
    });
    const args = JSON.parse(await readFile(log, "utf8")) as string[];
    expect(args.join(" ")).toContain(
      `src=${join(directory, "workspaces", workspaceId)},dst=/workspace`,
    );
    expect(args.join(" ")).toContain(
      `src=${join(directory, "secrets", "model-key")},dst=/run/pocketcoder/secrets/model%2Fkey,readonly`,
    );
    expect(args).not.toContain("MODEL_KEY_FILE=secretRef:model/key");
    expect(args).toContain("/tmp:rw,noexec,nosuid,size=256m,uid=12345,gid=23456,mode=0700");
    expect(args).toContain("/home/onefin:rw,noexec,nosuid,size=256m,uid=12345,gid=23456,mode=0700");
  });

  test("shares a restricted network namespace with a capability-limited egress companion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketcoder-docker-egress-"));
    temporaryDirectories.push(directory);
    const log = join(directory, "calls.ndjson");
    const docker = await dockerMock(`
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "image") console.log(args[2]);
else if (args[0] === "run") {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
  const name = args[args.indexOf("--name") + 1];
  console.log(name.startsWith("pocketcoder-egress-") ? "egress-id" : "workspace-id");
}
`);
    const parsed = parseTemplateManifest({
      apiVersion: "pocketcoder.dev/v1alpha1",
      kind: "Template",
      metadata: { name: "docker-egress" },
      spec: {
        version: "1.0.0",
        image: `registry.example/workspace@sha256:${"a".repeat(64)}`,
        harness: { command: ["/bin/true"] },
        resources: { cpu: "1", memory: "256Mi" },
        network: { mode: "restricted", allow: [{ domain: "github.com" }] },
      },
    });
    const id = randomUUID();
    const input: ProviderInput = {
      workspace_id: id,
      server_url: "http://host.docker.internal:7080",
      registration_secret: "one-time",
      template_digest: parsed.digest,
      template_name: "docker-egress",
      template_version: "1.0.0",
      launch_mode: "create",
    };
    const inputDir = join(directory, "input");
    const driver = new DockerDriver({
      dockerBin: docker,
      inputDir,
      egressImage: `registry.example/egress@sha256:${"e".repeat(64)}`,
      egressSigningKey: "test-signing-key",
    });
    const ref = await driver.create({
      workspace: {
        id,
        templateDigest: parsed.digest,
        templateSnapshot: snapshotOf(parsed),
        deadlineAt: new Date(Date.now() + 60_000),
      } as WorkspaceRow,
      input,
      mounts: [],
      secrets: [],
    });
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("NET_ADMIN");
    expect(calls[1]).toContain("container:egress-id");
    expect(ref).toMatchObject({ id: "workspace-id", egressId: "egress-id" });
    const workspaceInput = JSON.parse(await readFile(join(inputDir, `${id}.json`), "utf8"));
    expect(workspaceInput.server_url).toBe("http://127.0.0.1:18081");
    expect(JSON.stringify(workspaceInput)).not.toContain("audit_token");
    const gatewayInput = JSON.parse(await readFile(join(inputDir, `${id}-egress.json`), "utf8"));
    expect(gatewayInput.control_url).toBe(input.server_url);
    expect(gatewayInput.audit_token).toStartWith("pce1.");
  });
});
