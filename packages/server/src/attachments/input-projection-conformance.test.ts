import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import type { ProviderRef } from "@pstdio/pocketcoder-runtime-core";
import { inputFixture } from "./input-fixture.test";

const imageName = process.env.POCKETCODER_DOCKER_CONFORMANCE_IMAGE ?? "postgres:16-alpine";
const image = Bun.spawnSync(["docker", "image", "inspect", imageName, "--format", "{{.Id}}"], { stderr: "ignore" });
const available =
  image.exitCode === 0 && Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

describe.skipIf(!available)("pinned canonical inputs through the Docker publisher", () => {
  let f: Awaited<ReturnType<typeof inputFixture>>;
  let directory: string;
  let driver: DockerDriver;
  let ref: ProviderRef;
  beforeAll(async () => {
    f = await inputFixture();
    directory = await mkdtemp(join(tmpdir(), "pc128-pins-"));
    const imagePin = `${imageName}@${image.stdout.toString().trim()}`;
    const snapshot = snapshotOf(
      parseTemplateManifest({
        apiVersion: "pocketcoder.dev/v1alpha1",
        kind: "Template",
        metadata: { name: "input-pins" },
        spec: {
          version: "1.0.0",
          image: imagePin,
          harness: { command: ["/bin/true"] },
          command: ["/bin/sh", "-c", "while :; do sleep 1; done"],
          resources: { cpu: "1", memory: "128Mi" },
        },
      }),
    );
    driver = new DockerDriver({
      network: "none",
      addHostGateway: false,
      inputDir: join(directory, "launch"),
      inputProjection: {
        root: join(directory, "projection"),
        storage: f.driver,
        privateRoots: [f.root],
        probeImage: imagePin,
        capacity: { bytes: 16_777_216, files: 256 },
      },
    });
    ref = await driver.create({
      workspace: { ...f.workspace, templateDigest: snapshot.digest, templateSnapshot: snapshot },
      input: {
        workspace_id: f.workspace.id,
        server_url: "http://unused.invalid",
        registration_secret: "one-use-fixture",
        template_digest: snapshot.digest,
        template_name: "input-pins",
        template_version: "1.0.0",
        launch_mode: "create",
      },
      mounts: [],
      secrets: [],
    });
  }, 30_000);
  afterAll(async () => {
    if (ref) await driver.remove(ref);
    if (directory) await rm(directory, { recursive: true, force: true });
    await f?.dispose();
  }, 30_000);
  test("awaits verified pinned publication before consumption and preserves pins through provider cleanup", async () => {
    const uploaded = await f.upload();
    const manifestId = randomUUID();
    const selected = await f.service.freeze(manifestId, f.workspace.id, ref.id, [uploaded.reference.fileId]);
    const object = selected.objects[0];
    if (!object) throw new Error("Missing selected input.");
    const published = await driver.publishInputs(ref, selected);
    const child = Bun.spawn(["docker", "exec", ref.id, "cat", `${published.directory}/${uploaded.reference.fileId}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(child.stdout).text()).toBe("original");
    expect(await child.exited).toBe(0);
    await driver.releaseInputProjection(ref, manifestId);
    await driver.remove(ref);
    expect(
      await f.store.inputs.beginRelease(
        f.workspace.id,
        uploaded.reference.fileId,
        object.backing.versionId,
        new Date(Date.now() + f.limits.retentionMs + 1),
      ),
    ).toBe(false);
    await expect(f.service.purge(f.workspace.id)).rejects.toThrow("pins");
    expect((await f.store.inputs.get(f.workspace.id, uploaded.reference.fileId))?.state).toBe("ready");
    await f.service.finalize(manifestId);
    await f.driver.verify(object.backing, object.reference);
  }, 30_000);
});
