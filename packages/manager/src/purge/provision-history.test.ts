import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockDataFolder } from "@pstdio/pocketcoder-db/engine";
import { ObjectStorage, ObjectStorageError } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createRequestDigest } from "./intent";

const enabled = process.env.PC94_S3_TEST === "1";
const identity = (digest = createRequestDigest(randomUUID())) => ({
  accountId: randomUUID(),
  createRequestDigest: digest,
  originalCreateOperationId: randomUUID(),
});
const keys = (bound: ReturnType<typeof identity>, kind: "admission" | "start") =>
  [
    `manager/purge/provision/${bound.accountId}/${kind}.json`,
    `manager/purge/provision/requests/${bound.createRequestDigest}/${bound.accountId}/${kind}.json`,
  ] as const;

async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Owned storage command failed: ${error}`);
  return output.trim();
}

async function waitForHealth(endpoint: string, deadline: number) {
  for (;;) {
    try {
      if ((await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error("Owned RustFS restart deadline exceeded");
    await Bun.sleep(100);
  }
}

async function waitForBucket(storage: ObjectStorage, deadline: number) {
  // RustFS health precedes the existing bucket's recovery after a real restart.
  for (;;) {
    try {
      await storage.versions("manager/purge/provision/");
      return;
    } catch (error) {
      if (!(error instanceof ObjectStorageError) || error.status !== 503) throw error;
    }
    if (Date.now() > deadline) throw new Error("Owned RustFS bucket restart deadline exceeded");
    await Bun.sleep(100);
  }
}

async function historyFixture() {
  const root = await mkdtemp(join(tmpdir(), "pc94-provision-history-"));
  let storage: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
  let containerId: string | undefined;
  const locks: ReturnType<typeof lockDataFolder>[] = [];
  async function close() {
    for (const folder of locks) folder.close();
    const results = await Promise.allSettled([storage?.close(), rm(root, { recursive: true, force: true })]);
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length) throw new AggregateError(failures, "Provision history cleanup failed");
    try {
      await lstat(root);
      throw new Error("Owned history root remains after cleanup");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    console.log(JSON.stringify({ historyCleanup: "closed", containerId, locksClosed: locks.length, rootAbsent: true }));
  }
  try {
    const owned = await objectStorageFixture();
    storage = owned;
    let currentStorage = owned.storage;
    const ownedId = await docker("inspect", "--format", "{{.Id}}", owned.config.bucket);
    if (!/^[a-f0-9]{64}$/.test(ownedId)) throw new Error("Owned RustFS identity is missing");
    containerId = ownedId;
    return {
      root,
      get storage() {
        return currentStorage;
      },
      close,
      async open(name: string) {
        const folder = lockDataFolder(join(root, name));
        locks.push(folder);
        folder.validate();
        const directory = await lstat(folder.dir);
        const lock = await lstat(join(folder.dir, "LOCK"));
        console.log(
          JSON.stringify({
            historyFixture: "real RustFS and locked root",
            containerId: ownedId,
            directory: { device: directory.dev, inode: directory.ino, mode: directory.mode & 0o777 },
            lock: { device: lock.dev, inode: lock.ino, mode: lock.mode & 0o777 },
          }),
        );
        const { createProvisionHistory } = await import("./provision-history");
        return {
          folder,
          history: await createProvisionHistory({
            directory: folder.dir,
            storage: currentStorage,
            validate: folder.validate,
          }),
        };
      },
      stop: () => docker("stop", "--time", "1", ownedId),
      async restart() {
        await docker("start", ownedId);
        if ((await docker("inspect", "--format", "{{.Id}}", ownedId)) !== ownedId)
          throw new Error("Owned RustFS identity changed on restart");
        const published = await docker("port", ownedId, "9000/tcp");
        if (!/^127\.0\.0\.1:[0-9]+$/.test(published)) throw new Error("Owned RustFS port is not private");
        const endpoint = `http://${published}`;
        currentStorage = new ObjectStorage({ ...owned.config, endpoint });
        console.log(
          JSON.stringify({
            historyRestart: "same immutable RustFS container",
            containerId: ownedId,
            portChanged: new URL(endpoint).port !== new URL(owned.config.endpoint).port,
          }),
        );
        const deadline = Date.now() + 30_000;
        await waitForHealth(endpoint, deadline);
        await waitForBucket(currentStorage, deadline);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function ownedTest(run: (fixture: Awaited<ReturnType<typeof historyFixture>>) => Promise<void>) {
  const fixture = await historyFixture();
  let failure: unknown;
  try {
    await run(fixture);
  } catch (error) {
    failure = error;
  }
  try {
    await fixture.close();
  } catch (error) {
    throw new AggregateError([...(failure ? [failure] : []), error], "Provision history test cleanup failed");
  }
  if (failure) throw failure;
}

test.skipIf(!enabled)(
  "real provision history survives backend outage, restart and fresh roots without new versions",
  async () => {
    await ownedTest(async (fixture) => {
      const first = await fixture.open("authority");
      const bound = identity();
      await fixture.stop();
      await expect(first.history.admit(bound)).rejects.toThrow();
      const localPath = join(first.folder.dir, "provision-history", `${bound.accountId}.admission.json`);
      const proposal = JSON.parse(await readFile(localPath, "utf8"));
      expect(proposal).toMatchObject(bound);
      expect((await lstat(localPath)).mode & 0o777).toBe(0o600);
      first.folder.close();
      await fixture.restart();
      const restarted = await fixture.open("authority");
      expect(await restarted.history.admit(bound)).toEqual(proposal);
      const started = await restarted.history.start(bound);
      const fresh = await fixture.open("fresh");
      expect(await fresh.history.admit(bound)).toEqual(proposal);
      expect(await fresh.history.start(bound)).toEqual(started);
      expect(await fresh.history.read(bound.accountId)).toEqual({ admission: proposal, start: started });
      for (const [kind, record] of [
        ["admission", proposal],
        ["start", started],
      ] as const) {
        for (const key of keys(bound, kind)) {
          const versions = await fixture.storage.versions(key);
          expect(versions).toHaveLength(1);
          const version = versions[0];
          if (!version) throw new Error("Actual provision version is missing");
          expect(await (await fixture.storage.get(key, version.versionId)).json()).toEqual(record);
        }
      }
      await expect(fresh.history.admit({ ...bound, originalCreateOperationId: randomUUID() })).rejects.toThrow(
        "identity",
      );
      const empty = await fixture.open("empty-conflict");
      await expect(
        empty.history.start({ ...bound, createRequestDigest: createRequestDigest(randomUUID()) }),
      ).rejects.toThrow("identity");
      const alias = identity(bound.createRequestDigest);
      const aliasAdmission = await fresh.history.admit(alias);
      const oldPending = identity(bound.createRequestDigest);
      const oldStart = await fresh.history.start(oldPending);
      expect(await fresh.history.read(oldPending.accountId)).toEqual({ admission: null, start: oldStart });
      expect(await fixture.storage.versions(keys(oldPending, "admission")[0])).toEqual([]);
      const listed = await fresh.history.listByCreateDigest(bound.createRequestDigest);
      expect(listed.sort((a, b) => a.identity.accountId.localeCompare(b.identity.accountId))).toEqual(
        [
          { identity: bound, admission: proposal, start: started },
          { identity: alias, admission: aliasAdmission, start: null },
          { identity: oldPending, admission: null, start: oldStart },
        ].sort((a, b) => a.identity.accountId.localeCompare(b.identity.accountId)),
      );
      const before = await fixture.storage.versions("manager/purge/provision/");
      await fixture.storage.put(`accounts/${bound.accountId}/archive.enc`, Buffer.from("owned fixture bytes"));
      await fixture.storage.clean(`accounts/${bound.accountId}/`);
      expect(await fixture.storage.versions("manager/purge/provision/")).toEqual(before);
      expect(await fresh.history.read(randomUUID())).toEqual({ admission: null, start: null });
      console.log(
        JSON.stringify({
          provisionHistory: "durable",
          accountId: bound.accountId,
          outage: "actual owned RustFS stop/restart",
          aliases: listed.length,
          scope: "receipt storage only; provider absence and admission caller prerequisites excluded",
        }),
      );
    });
  },
  60_000,
);

test.skipIf(!enabled)(
  "fresh roots repair actual partial indexes and reject mismatched immutable history",
  async () => {
    await ownedTest(async (fixture) => {
      const bound = identity();
      const admission = {
        format: "pocketcoder-provision-admission/v1" as const,
        ...bound,
        admittedAt: new Date().toISOString(),
      };
      await fixture.storage.putIfAbsent(keys(bound, "admission")[0], Buffer.from(JSON.stringify(admission)));
      const owned = await fixture.open("authority");
      expect(await owned.history.listByCreateDigest(bound.createRequestDigest)).toEqual([
        { identity: bound, admission, start: null },
      ]);
      expect(await (await fixture.storage.get(keys(bound, "admission")[1])).json()).toEqual(admission);
      const pending = identity(bound.createRequestDigest);
      const start = {
        format: "pocketcoder-provision-start/v1" as const,
        ...pending,
        startedAt: new Date().toISOString(),
      };
      await fixture.storage.putIfAbsent(keys(pending, "start")[1], Buffer.from(JSON.stringify(start)));
      const fresh = await fixture.open("fresh");
      expect(await fresh.history.listByCreateDigest(bound.createRequestDigest)).toHaveLength(2);
      expect(await fresh.history.read(pending.accountId)).toEqual({ admission: null, start });
      expect(await (await fixture.storage.get(keys(pending, "start")[0])).json()).toEqual(start);
      for (const key of [...keys(bound, "admission"), ...keys(pending, "start")])
        expect(await fixture.storage.versions(key)).toHaveLength(1);
      const conflict = identity();
      const first = {
        format: "pocketcoder-provision-admission/v1" as const,
        ...conflict,
        admittedAt: new Date().toISOString(),
      };
      const different = { ...first, admittedAt: new Date(Date.parse(first.admittedAt) - 1).toISOString() };
      await fixture.storage.putIfAbsent(keys(conflict, "admission")[0], Buffer.from(JSON.stringify(first)));
      await fixture.storage.putIfAbsent(keys(conflict, "admission")[1], Buffer.from(JSON.stringify(different)));
      await expect(fresh.history.read(conflict.accountId)).rejects.toThrow("index");
      const mixed = identity();
      await fresh.history.admit(mixed);
      const wrong = {
        format: "pocketcoder-provision-start/v1" as const,
        ...mixed,
        originalCreateOperationId: randomUUID(),
        startedAt: new Date().toISOString(),
      };
      await fixture.storage.putIfAbsent(keys(mixed, "start")[0], Buffer.from(JSON.stringify(wrong)));
      await expect(fresh.history.read(mixed.accountId)).rejects.toThrow("identity");
    });
  },
  30_000,
);

test.skipIf(!enabled)(
  "provision history rejects oversized records, deleted indexes and redirected local custody",
  async () => {
    await ownedTest(async (fixture) => {
      const owned = await fixture.open("authority");
      const bound = identity();
      const record = {
        format: "pocketcoder-provision-admission/v1" as const,
        ...bound,
        admittedAt: new Date().toISOString(),
      };
      await fixture.storage.putIfAbsent(
        keys(bound, "admission")[0],
        Buffer.from(`${JSON.stringify(record)}${" ".repeat(65_536)}`),
      );
      await expect(owned.history.read(bound.accountId)).rejects.toThrow("metadata limit");
      const removed = identity();
      await owned.history.admit(removed);
      await (await fixture.storage.request("DELETE", keys(removed, "admission")[1])).body?.cancel();
      await expect(owned.history.read(removed.accountId)).rejects.toThrow("deleted");
      const redirected = identity();
      const outside = join(fixture.root, "outside.json");
      await Bun.write(outside, JSON.stringify(record));
      await symlink(outside, join(owned.folder.dir, "provision-history", `${redirected.accountId}.admission.json`));
      await expect(owned.history.admit(redirected)).rejects.toThrow("private");
      expect(await Bun.file(outside).text()).toBe(JSON.stringify(record));
      expect(await fixture.storage.versions(keys(redirected, "admission")[0])).toEqual([]);
    });
  },
  30_000,
);
