import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { loadOffNodeConfig, restoreOffNodeBackup } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { openControllerStore } from "../bootstrap/controller-store";
import { createMaintenance } from "../maintenance/maintenance";
import { checkpointHttpFixture } from "../persistence/checkpoint-transfer-fixture.test";
import { createControllerBackup } from "./controller-backup";
import { crashProcess, killWhen, pauseBefore } from "./crash-process";
import { createOffNodeBackup } from "./off-node-backup";

const enabled = process.env.RUN_S3_INTEGRATION === "1";
async function privateConfig(root: string, storage: Awaited<ReturnType<typeof objectStorageFixture>>["config"]) {
  const key = join(root, "outer-key");
  await writeFile(key, randomBytes(32), { mode: 0o600 });
  const path = join(root, "off-node.json");
  await writeFile(path, JSON.stringify({ accountId: randomUUID(), storage, encryptionKeyFile: key }), { mode: 0o600 });
  return { path, offNode: await loadOffNodeConfig(path) };
}
test.skipIf(!enabled)(
  "SIGKILL during capture retries one off-node operation instead of colliding with its partial archive",
  async () => {
    const fixture = await objectStorageFixture();
    const root = await mkdtemp(join(tmpdir(), "pc93-capture-crash-"));
    let controller: Awaited<ReturnType<typeof openControllerStore>> | undefined;
    try {
      const { path, offNode } = await privateConfig(root, fixture.config);
      const id = randomUUID();
      const source = join(root, "source");
      const operation = join(root, "operations", id);
      const child = crashProcess({ kind: "backup", path, source, id });
      await killWhen(child, async () => existsSync(join(operation, ".backup.tar.partial")));
      expect(existsSync(join(operation, ".backup.tar.partial"))).toBe(true);
      expect(existsSync(join(operation, "backup.tar"))).toBe(false);
      controller = await openControllerStore(source, undefined, { acknowledgeJournal: offNode.journal.acknowledge });
      const killedIntent = await Bun.file(join(operation, "intent.json")).json();
      const charged = await controller.store.storageReservations.get(killedIntent.reservationId);
      expect(charged?.state).toBe("reserved");
      expect(charged?.reservedBytes).toBeGreaterThan(0);
      const backup = createOffNodeBackup({
        store: controller.store,
        offNode,
        backup: createControllerBackup({
          store: controller.store,
          keys: controller.keys,
          maintenance: createMaintenance(),
        }),
      });
      const receipt = await backup(id, new AbortController().signal);
      expect(receipt.operationId).toBe(id);
      expect(await fixture.storage.versions(`accounts/${receipt.accountId}/backups/${id}/`)).toHaveLength(1);
      expect(existsSync(join(operation, ".backup.tar.partial"))).toBe(false);
      expect((await controller.store.storageReservations.get(killedIntent.reservationId))?.state).toBe("released");
      expect((await controller.store.storageReservations.get(receipt.staging.reservationId))?.state).toBe("released");
    } finally {
      await controller?.store.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!enabled)(
  "SIGKILL during private verification keeps staging charged until the exact scratch is removed",
  async () => {
    const fixture = await objectStorageFixture();
    const root = await mkdtemp(join(tmpdir(), "pc93-verify-crash-"));
    let controller: Awaited<ReturnType<typeof openControllerStore>> | undefined;
    try {
      const { path, offNode } = await privateConfig(root, fixture.config);
      const id = randomUUID();
      const source = join(root, "source");
      const directory = join(root, "operations", id);
      const child = crashProcess({ kind: "backup", path, source, id });
      await killWhen(child, async () => existsSync(join(directory, "verify", "db", "PG_VERSION")));
      const intent = await Bun.file(join(directory, "intent.json")).json();
      expect((await stat(join(directory, "verify"))).mode & 0o777).toBe(0o700);
      controller = await openControllerStore(source, undefined, { acknowledgeJournal: offNode.journal.acknowledge });
      const reservation = await controller.store.storageReservations.get(intent.reservationId);
      expect(reservation?.state).toBe("reserved");
      expect(reservation?.reservedBytes).toBeGreaterThan(reservation?.materializedBytes ?? 0);
      const receipt = await createOffNodeBackup({
        store: controller.store,
        offNode,
        backup: createControllerBackup({
          store: controller.store,
          keys: controller.keys,
          maintenance: createMaintenance(),
        }),
      })(id, new AbortController().signal);
      expect(receipt.staging.reservationId).toBe(intent.reservationId);
      expect((await controller.store.storageReservations.get(intent.reservationId))?.state).toBe("released");
      expect(existsSync(join(directory, "verify"))).toBe(false);
      expect(await fixture.storage.versions(`accounts/${receipt.accountId}/backups/${id}/`)).toHaveLength(1);
    } finally {
      await controller?.store.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!enabled)(
  "SIGKILL after checkpoint extraction retries the same fresh-volume operation",
  async () => {
    const fixture = await objectStorageFixture();
    const root = await mkdtemp(join(tmpdir(), "pc93-extract-crash-"));
    const source = await checkpointHttpFixture(Buffer.from("saved bytes after crash"));
    try {
      const preserved = source.service.preserve(source.workspace, source.checkpoint, source.operationId);
      const grant = await source.grant;
      expect((await fetch(grant.url, { method: "PUT", headers: source.headers(grant), body: source.raw })).status).toBe(
        201,
      );
      await preserved;
      const { path, offNode } = await privateConfig(root, fixture.config);
      await offNode.journal.acknowledge(source.store.journalSnapshot());
      const keys = {
        pepper: randomBytes(32).toString("base64url"),
        secretKey: randomBytes(32).toString("base64url"),
        eventSigningKey: randomBytes(32).toString("base64url"),
      };
      const receipt = await createOffNodeBackup({
        store: source.store,
        offNode,
        backup: createControllerBackup({
          store: source.store,
          keys,
          maintenance: createMaintenance(),
          checkpointDirectory: source.directory,
        }),
      })(randomUUID(), new AbortController().signal);
      await source.store.close();
      const input = {
        operationId: randomUUID(),
        receipt,
        dataDir: join(root, "fresh"),
        journalDir: join(root, "fresh-journal"),
        checkpointDir: join(root, "checkpoints"),
      };
      const occupied = {
        ...input,
        operationId: randomUUID(),
        dataDir: join(root, "untouched-data"),
        checkpointDir: join(root, "untouched-checkpoints"),
      };
      await mkdir(occupied.checkpointDir);
      await writeFile(join(occupied.checkpointDir, "keep"), "caller-owned");
      await expect(restoreOffNodeBackup({ ...occupied, offNode })).rejects.toThrow("must be empty");
      expect(await Bun.file(join(occupied.checkpointDir, "keep")).text()).toBe("caller-owned");
      expect(existsSync(occupied.dataDir)).toBe(false);
      const child = crashProcess({ kind: "restore", path, input });
      const stage = join(root, `.checkpoints.restore-${input.operationId}`);
      await killWhen(child, async () => {
        for (const directory of [input.checkpointDir, stage]) {
          if (existsSync(directory) && (await readdir(directory)).some((name) => name.endsWith(".tar"))) return true;
        }
        return false;
      });
      expect(existsSync(join(input.dataDir, "LOCK"))).toBe(false);
      const restoreDirectory = join(root, "restores", input.operationId);
      expect((await Bun.file(join(restoreDirectory, "capacity.json")).json()).amount.bytes).toBeGreaterThan(0);
      const result = await restoreOffNodeBackup({ ...input, offNode });
      expect(result.recovery.snapshotId).toBe(receipt.snapshotId);
      expect(result.checkpoints).toBe(1);
      expect(await readdir(input.checkpointDir)).toHaveLength(1);
      expect(await restoreOffNodeBackup({ ...input, offNode })).toEqual(result);
      expect(existsSync(stage)).toBe(false);
      expect(existsSync(join(restoreDirectory, "capacity.json"))).toBe(false);
      const restored = await PGliteStore.create(input.dataDir, { journalDir: input.journalDir });
      try {
        expect((await restored.storageReservations.get(receipt.staging.reservationId))?.state).toBe("released");
        expect((await restored.storageReservations.usage(null, null)).instance.bytes).toBeGreaterThan(0);
      } finally {
        await restored.close();
      }

      const publication = {
        ...input,
        operationId: randomUUID(),
        dataDir: join(root, "published"),
        journalDir: join(root, "published-journal"),
        checkpointDir: join(root, "published-checkpoints"),
      };
      const paused = await pauseBefore(
        { kind: "restore", path, input: publication },
        "packages/db/src/backup/restore-backup.ts",
        "renameSync(stage, target)",
        "syncDirectory(parent)",
      );
      let lock: Awaited<ReturnType<typeof stat>>;
      try {
        lock = await stat(join(publication.dataDir, "LOCK"));
        expect(existsSync(join(root, `.published-checkpoints.restore-${publication.operationId}`))).toBe(true);
      } finally {
        await paused.kill();
      }
      const published = await restoreOffNodeBackup({ ...publication, offNode });
      expect(published.recovery.snapshotId).toBe(receipt.snapshotId);
      expect(await readdir(publication.checkpointDir)).toHaveLength(1);
      expect((await stat(join(publication.dataDir, "LOCK"))).ino).toBe(lock.ino);

      const linking = {
        ...publication,
        operationId: randomUUID(),
        dataDir: join(root, "linked"),
        journalDir: join(root, "linked-journal"),
        checkpointDir: join(root, "linked-checkpoints"),
      };
      const linked = await pauseBefore(
        { kind: "restore", path, input: linking },
        "packages/db/src/off-node/restore-staging.ts",
        "await link(source, output)",
        "syncDirectory(staging.checkpoints)",
      );
      const checkpointName = (await readdir(linking.checkpointDir))[0] as string;
      try {
        lock = await stat(join(linking.dataDir, "LOCK"));
        expect((await stat(join(linking.checkpointDir, checkpointName))).nlink).toBe(2);
      } finally {
        await linked.kill();
      }
      expect((await restoreOffNodeBackup({ ...linking, offNode })).checkpoints).toBe(1);
      expect((await stat(join(linking.dataDir, "LOCK"))).ino).toBe(lock.ino);
      expect((await stat(join(linking.checkpointDir, checkpointName))).nlink).toBe(1);
    } finally {
      await source.dispose();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!enabled)(
  "SIGKILL after durable completion cleans backup and restore scratch on retry",
  async () => {
    const fixture = await objectStorageFixture();
    const root = await mkdtemp(join(tmpdir(), "pc93-completion-crash-"));
    let controller: Awaited<ReturnType<typeof openControllerStore>> | undefined;
    try {
      const { path, offNode } = await privateConfig(root, fixture.config);
      const id = randomUUID();
      const source = join(root, "source");
      const operation = join(root, "operations", id);
      const captured = await pauseBefore(
        { kind: "backup", path, source, id },
        "packages/server/src/backup/off-node-backup.ts",
        "await writePrivateJson(receiptPath, receipt,",
        "await rm(archive)",
      );
      try {
        expect(existsSync(join(operation, "receipt.json"))).toBe(true);
        expect(existsSync(join(operation, "backup.tar"))).toBe(true);
        expect(existsSync(join(operation, "backup.enc"))).toBe(true);
      } finally {
        await captured.kill();
      }
      const receipt = await Bun.file(join(operation, "receipt.json")).json();
      controller = await openControllerStore(source, undefined, { acknowledgeJournal: offNode.journal.acknowledge });
      const backup = createOffNodeBackup({
        store: controller.store,
        offNode,
        backup: createControllerBackup({
          store: controller.store,
          keys: controller.keys,
          maintenance: createMaintenance(),
        }),
      });
      expect(await backup(id, new AbortController().signal)).toEqual(receipt);
      expect(await readdir(operation)).toEqual(["receipt.json"]);
      await controller.store.close();
      controller = undefined;
      const input = {
        operationId: randomUUID(),
        receipt,
        dataDir: join(root, "fresh"),
        journalDir: join(root, "fresh-journal"),
        checkpointDir: join(root, "checkpoints"),
      };
      const restored = await pauseBefore(
        { kind: "restore", path, input },
        "packages/db/src/off-node/restore.ts",
        "await writePrivateJson(resultPath, result,",
        "await rm(encrypted)",
      );
      const directory = join(root, "restores", input.operationId);
      let lock: Awaited<ReturnType<typeof stat>>;
      try {
        expect(existsSync(join(directory, "result.json"))).toBe(true);
        expect(existsSync(join(directory, "backup.tar"))).toBe(true);
        expect(existsSync(join(directory, "backup.enc"))).toBe(true);
        expect(existsSync(join(directory, "capacity.json"))).toBe(true);
        lock = await stat(join(input.dataDir, "LOCK"));
      } finally {
        await restored.kill();
      }
      const result = await Bun.file(join(directory, "result.json")).json();
      expect(await restoreOffNodeBackup({ ...input, offNode })).toEqual(result);
      expect((await stat(join(input.dataDir, "LOCK"))).ino).toBe(lock.ino);
      expect((await readdir(directory)).sort()).toEqual(["intent.json", "result.json"]);
    } finally {
      await controller?.store.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
