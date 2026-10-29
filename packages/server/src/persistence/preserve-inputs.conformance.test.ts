import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  DockerDriver,
  FilesystemInputStorage,
  FilesystemStorageDriver,
  type ProviderRef,
} from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";

const image = "postgres:16-alpine";
const inspected = Bun.spawnSync(["docker", "image", "inspect", image, "--format", "{{.Id}}"], { stderr: "ignore" });
const available = inspected.exitCode === 0;
const imagePin = `${image}@${inspected.stdout.toString().trim()}`;

test.skipIf(!available)(
  "preserve removes the provider before purging its immutable input mount",
  async () => {
    const f = await checkpointHttpFixture();
    const root = join(f.directory, "..", "projection");
    const canonical = join(f.directory, "..", "canonical");
    const driver = new DockerDriver({
      inputDir: join(f.directory, "..", "launch"),
      network: "none",
      addHostGateway: false,
      inputProjection: {
        root,
        storage: new FilesystemInputStorage(canonical, [root]),
        privateRoots: [canonical],
        capacity: { bytes: 8388608, files: 64 },
        probeImage: imagePin,
      },
    });
    const server = buildServer({
      store: f.store,
      driver,
      storageDriver: new FilesystemStorageDriver({
        workspaceRoot: join(f.directory, "..", "work"),
        checkpointRoot: f.directory,
      }),
      pepper: "preserve-input-fixture",
      limits: DEFAULT_LIMITS,
      workspaceServerUrl: "http://127.0.0.1",
      checkpointTransferOptions: {
        readCapacity: () => {
          throw new Error("A published checkpoint must not reserve another transfer");
        },
        directory: f.directory,
        agentBaseUrl: "http://127.0.0.1",
        limits: {
          deadlineMs: 3000,
          maxArchiveBytes: 65536,
          maxIndexBytes: 65536,
          maxQueueBytes: 65536,
          maxLedgerBytes: 65536,
        },
        retentionLimits: {
          maxCheckpointFiles: 100,
          maxRetainedBytes: 1000000,
          maxRetainedBytesPerPrincipal: 1000000,
          maxCheckpointsPerPrincipal: 10,
        },
      },
    });
    let ref: ProviderRef | undefined;
    try {
      ref = await driver.create({
        workspace: {
          ...f.workspace,
          templateSnapshot: {
            ...f.workspace.templateSnapshot,
            spec: {
              ...f.workspace.templateSnapshot.spec,
              image: imagePin,
              command: ["/bin/sh", "-c", "while :; do sleep 1; done"],
            },
          },
        },
        input: {
          workspace_id: f.workspace.id,
          server_url: "http://unused.invalid",
          registration_secret: "one-use-fixture",
          template_digest: f.workspace.templateDigest,
          template_name: f.workspace.templateSnapshot.name,
          template_version: f.workspace.templateSnapshot.version,
          launch_mode: "create",
        },
        mounts: [],
        secrets: [],
      });
      await f.store.updateWorkspace(f.workspace.id, { providerKind: "docker", providerRef: ref }, new Date());
      expect((await driver.inspect(ref)).inputStorage?.profile).toBe("controller-readonly/v1");
      await expect(driver.purgeInput(f.workspace.id)).rejects.toThrow("removal");
      const pending = f.service.preserve(f.workspace, f.checkpoint, f.operationId);
      const grant = await f.grant;
      expect((await fetch(grant.url, { method: "PUT", headers: f.headers(grant), body: f.raw })).status).toBe(201);
      await pending;
      await f.store.updateOperation(f.operationId, { state: "pending" }, new Date());
      await server.persistence.retryPreserves();
      await server.persistence.drain();
      expect(await f.store.getWorkspace(f.workspace.id)).toMatchObject({ state: "preserved" });
      expect(await f.store.getOperation(f.operationId)).toMatchObject({ state: "succeeded" });
      expect(await f.store.getStorage(f.checkpoint.storageId)).toMatchObject({ state: "deleted" });
      expect((await driver.inspect(ref)).running).toBe(false);
      await driver.purgeInput(f.workspace.id);
    } finally {
      await server.persistence.drain();
      await server.checkpointTransfers?.close();
      if (ref) await driver.remove(ref);
      await f.dispose();
    }
  },
  30000,
);
