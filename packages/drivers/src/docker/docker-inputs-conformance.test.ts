import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { digestOf } from "@pstdio/pocketcoder-contracts";
import type { ProviderRef } from "@pstdio/pocketcoder-runtime-core";
import { DockerDriver } from "./docker";
import { runDocker } from "./docker-command";
import {
  dockerProjectionAvailable as available,
  dockerProjectionFixture as fixture,
} from "./docker-inputs-fixture.test";

describe.skipIf(!available)("Docker immutable input boundary", () => {
  let incarnationId: string;
  let f: Awaited<ReturnType<typeof fixture>>;
  let ref: ProviderRef;
  let object: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["input"]>>;
  let selected: ReturnType<Awaited<ReturnType<typeof fixture>>["selection"]>;
  let published: Awaited<ReturnType<DockerDriver["publishInputs"]>>;
  beforeAll(async () => {
    f = await fixture();
    ref = await f.create();
    const observed = await f.driver.inspect(ref);
    if (!observed.containerIdentity) throw new Error("Runtime identity missing");
    incarnationId = observed.containerIdentity;
    object = await f.input();
    selected = selection([object]);
    published = await f.driver.publishInputs(ref, selected);
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  }, 30_000);
  function selection(objects: typeof selected.objects) {
    const input = f.selection(objects);
    input.manifest.incarnationId = incarnationId;
    input.manifest.digest = digestOf({
      workspaceId: f.scope.workspaceId,
      incarnationId,
      objects: input.manifest.objects,
    });
    return input;
  }
  test("read-only from creation; rejects every mutation and preserves bytes and manifest", async () => {
    expect((await f.driver.inspect(ref)).inputStorage?.profile).toBe("controller-readonly/v1");
    const path = `${published.directory}/${object.reference.fileId}`;
    const manifestPath = `${published.directory}/manifest.json`;
    const originalManifest = await runDocker("docker", ["exec", ref.id, "cat", manifestPath]);
    const attacks = [
      `printf modified > ${path}`,
      `printf forged > ${path}.json`,
      `chmod 777 ${path}`,
      `mv ${path} ${path}.old`,
      `rm ${path} && ln -s /tmp/fake ${path}`,
      `printf forged > ${manifestPath}`,
      "mkdir /run/pocketcoder/inputs/caller-chosen",
    ];
    const probe = attacks
      .map(
        (attack) =>
          `if (${attack}); then exit 1; fi; test "$(cat ${path})" = original; cat ${manifestPath}; printf '\n'`,
      )
      .join("; ");
    const observed = await runDocker("docker", ["exec", ref.id, "/bin/sh", "-eu", "-c", probe]);
    expect(observed.split("\n")).toEqual(attacks.map(() => originalManifest));
    await runDocker("docker", [
      "exec",
      ref.id,
      "/bin/sh",
      "-eu",
      "-c",
      "printf work > /tmp/output; test -s /tmp/output",
    ]);
  }, 30_000);
  test("active work sees later publication through the original mount", async () => {
    const uploaded = await f.input("later upload");
    const later = selection([uploaded]);
    const added = await f.driver.publishInputs(ref, later);
    expect(await runDocker("docker", ["exec", ref.id, "cat", `${added.directory}/${uploaded.reference.fileId}`])).toBe(
      "later upload",
    );
    expect(
      await runDocker("docker", ["exec", ref.id, "cat", `${published.directory}/${object.reference.fileId}`]),
    ).toBe("original");
  }, 30_000);
  test("rebuilds a lost execution after publisher restart and fences live cleanup", async () => {
    const scope = { workspaceId: f.scope.workspaceId, projectionId: String(ref.inputProjectionId) };
    await rm(join(f.publisher.path(scope), selected.manifestId), { recursive: true });
    const restarted = new DockerDriver(f.options);
    const discovered = (await restarted.list()).find((item) => item.workspaceId === f.scope.workspaceId);
    if (!discovered) throw new Error("Missing fixture container.");
    expect(discovered.ref.id).toBe(ref.id);
    await restarted.publishInputs(discovered.ref, selected);
    expect(
      await runDocker("docker", ["exec", ref.id, "cat", `${published.directory}/${object.reference.fileId}`]),
    ).toBe("original");
    await expect(f.driver.purgeInput(f.scope.workspaceId)).rejects.toThrow("removal");
    await f.storage.verify(object.backing, object.reference);
  }, 30_000);
  test("rejects writable aliases, parent aliases, nested targets and substituted incarnations", async () => {
    for (const path of [f.root, f.canonical, f.directory]) {
      f.launch.mounts = [{ name: "alias", target: "/work", source: { kind: "host-path", path } }];
      await expect(f.driver.create(f.launch)).rejects.toThrow("aliases");
    }
    const alias = join(f.directory, "alias");
    await symlink(f.root, alias);
    f.launch.mounts = [{ name: "alias", target: "/work", source: { kind: "host-path", path: alias } }];
    await expect(f.driver.create(f.launch)).rejects.toThrow("aliases");
    for (const target of ["/run", "/run/pocketcoder/inputs/nested"]) {
      f.launch.mounts = [{ name: "nested", target, source: { kind: "tmpfs", maxBytes: 1024, uid: 10001, gid: 10001 } }];
      await expect(f.driver.create(f.launch)).rejects.toThrow("overlaps");
    }
    f.launch.mounts = [];
    await expect(f.driver.publishInputs({ ...ref, inputProjectionId: randomUUID() }, f.selection([]))).rejects.toThrow(
      "boundary",
    );
  }, 30_000);
  test("a lost stable mount root cannot advertise support or dispatch through a new inode", async () => {
    const scope = { workspaceId: f.scope.workspaceId, projectionId: String(ref.inputProjectionId) };
    const path = f.publisher.path(scope);
    await rename(path, `${path}-lost`);
    try {
      await mkdir(path);
      const state = await f.driver.inspect(ref);
      expect(state.running).toBe(true);
      expect(state.inputStorage).toBeUndefined();
      await expect(f.driver.publishInputs(ref, selected)).rejects.toThrow();
    } finally {
      await rm(path, { recursive: true, force: true });
      await rename(`${path}-lost`, path);
    }
  }, 30_000);
});
