import { join } from "node:path";
import { type ProviderInput, parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { ProviderRef, WorkspaceLaunch, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { projectionFixture } from "../filesystem/projection-fixture.test";
import { DockerDriver } from "./docker";

const imageName = process.env.POCKETCODER_DOCKER_CONFORMANCE_IMAGE ?? "postgres:16-alpine";
const image = Bun.spawnSync(["docker", "image", "inspect", imageName, "--format", "{{.Id}}"], { stderr: "ignore" });
export const dockerProjectionAvailable =
  image.exitCode === 0 && Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

export async function dockerProjectionFixture() {
  const f = await projectionFixture();
  const imagePin = `${imageName}@${image.stdout.toString().trim()}`;
  const snapshot = snapshotOf(
    parseTemplateManifest({
      apiVersion: "pocketcoder.dev/v1alpha1",
      kind: "Template",
      metadata: { name: "input-projection" },
      spec: {
        version: "1.0.0",
        image: imagePin,
        harness: { command: ["/bin/true"] },
        command: ["/bin/sh", "-c", "while :; do sleep 1; done"],
        resources: { cpu: "1", memory: "128Mi" },
      },
    }),
  );
  const launch: WorkspaceLaunch = {
    workspace: {
      id: f.scope.workspaceId,
      templateDigest: snapshot.digest,
      templateSnapshot: snapshot,
      deadlineAt: new Date(Date.now() + 600_000),
    } as WorkspaceRow,
    input: {
      workspace_id: f.scope.workspaceId,
      server_url: "http://unused.invalid",
      registration_secret: "one-use-fixture",
      template_digest: snapshot.digest,
      template_name: "input-projection",
      template_version: "1.0.0",
      launch_mode: "create",
    } satisfies ProviderInput,
    mounts: [],
    secrets: [],
  };
  const options = {
    inputDir: join(f.directory, "launch"),
    network: "none",
    addHostGateway: false,
    inputProjection: {
      root: f.root,
      storage: f.storage,
      privateRoots: [f.canonical],
      capacity: { bytes: 8_388_608, files: 64 },
      probeImage: imagePin,
    },
  };
  const driver = new DockerDriver(options);
  let ref: ProviderRef | undefined;
  return {
    ...f,
    driver,
    options,
    launch,
    async create() {
      ref = await driver.create(launch);
      return ref;
    },
    async close() {
      if (ref) await driver.remove(ref);
      await f.close();
    },
  };
}
