import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountPurgeCompletion,
  AccountPurgeCompletionSchema,
  type AccountPurgeIntent,
} from "@pstdio/pocketcoder-contracts";
import { lockDataFolder } from "@pstdio/pocketcoder-db/engine";
import { ObjectStorage, ObjectStorageError } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createRequestDigest, purgeRequestDigest } from "./intent";

const enabled = process.env.PC94_S3_TEST === "1";
const intent = (): AccountPurgeIntent => ({
  format: "pocketcoder-account-purge/v1",
  accountId: randomUUID(),
  operationId: randomUUID(),
  createRequestDigest: createRequestDigest(randomUUID()),
  purgeRequestDigest: purgeRequestDigest(randomUUID()),
  admittedAt: new Date().toISOString(),
});
const key = (accountId: string) => `manager/purge/accounts/${accountId}/complete.json`;

async function receiptFixture() {
  const root = await mkdtemp(join(tmpdir(), "pc94-completion-"));
  let storage: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  const locks: ReturnType<typeof lockDataFolder>[] = [];
  let rejectWrites = false;
  let concurrent: AccountPurgeCompletion | undefined;
  let conditionalConflicts = 0;
  async function close() {
    for (const folder of locks) folder.close();
    const results = await Promise.allSettled([proxy?.stop(true), storage?.close()]);
    results.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])));
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Completion fixture cleanup failed");
  }
  try {
    const owned = await objectStorageFixture();
    storage = owned;
    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        // Only the transport fault is synthetic. Every successful result is from real RustFS.
        if (rejectWrites && request.method === "PUT") return new Response(null, { status: 503 });
        const url = new URL(request.url);
        const requested = decodeURIComponent(url.pathname.slice(`/${owned.config.bucket}/`.length));
        try {
          if (request.method === "PUT" && concurrent && requested === key(concurrent.intent.accountId)) {
            const earlier = concurrent;
            concurrent = undefined;
            await owned.storage.putIfAbsent(requested, Buffer.from(JSON.stringify(earlier)));
          }
          const condition = request.headers.get("if-none-match");
          return await owned.storage.request(
            request.method,
            requested,
            Object.fromEntries(url.searchParams),
            request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
            condition ? { "if-none-match": condition } : {},
          );
        } catch (error) {
          if (error instanceof ObjectStorageError) {
            if (error.status === 412) conditionalConflicts++;
            return new Response(null, { status: error.status });
          }
          throw error;
        }
      },
    });
    const endpoint = new ObjectStorage({ ...owned.config, endpoint: proxy.url.toString() });
    async function open(name: string) {
      const folder = lockDataFolder(join(root, name));
      locks.push(folder);
      const { createPurgeCompletion } = await import("./completion");
      return {
        folder,
        receipts: await createPurgeCompletion({ directory: folder.dir, validate: folder.validate, storage: endpoint }),
      };
    }
    return {
      root,
      storage: owned.storage,
      open,
      close,
      rejectWrites: (value: boolean) => {
        rejectWrites = value;
      },
      publishBeforeWrite: (completion: AccountPurgeCompletion) => {
        concurrent = completion;
      },
      conflicts: () => conditionalConflicts,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test.skipIf(!enabled)(
  "completion retries retain their canonical receipt through outage, restart and a fresh authority root",
  async () => {
    const fixture = await receiptFixture();
    let failure: unknown;
    try {
      const first = await fixture.open("authority");
      const request = intent();
      fixture.rejectWrites(true);
      await expect(first.receipts.complete(request)).rejects.toThrow("503");
      const path = join(first.folder.dir, "completions", `${request.accountId}.json`);
      const candidate = AccountPurgeCompletionSchema.parse(JSON.parse(await readFile(path, "utf8")));
      expect(candidate.intent).toEqual(request);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect(await first.receipts.read(request)).toBeNull();
      first.folder.close();
      const restarted = await fixture.open("authority");
      fixture.rejectWrites(false);
      expect(await restarted.receipts.complete(request)).toEqual(candidate);
      expect(await restarted.receipts.read(request)).toEqual(candidate);
      restarted.folder.close();
      const again = await fixture.open("authority");
      const fresh = await fixture.open("fresh-authority");
      expect(await again.receipts.complete(request)).toEqual(candidate);
      expect(await fresh.receipts.complete(request)).toEqual(candidate);
      expect(
        JSON.parse(await readFile(join(fresh.folder.dir, "completions", `${request.accountId}.json`), "utf8")),
      ).toEqual(candidate);
      const versions = await fixture.storage.versions(key(request.accountId));
      expect(versions).toHaveLength(1);
      const exactVersion = versions[0];
      if (!exactVersion) throw new Error("Actual completion version is missing");
      expect(await (await fixture.storage.get(exactVersion.key, exactVersion.versionId)).json()).toEqual(candidate);
      await expect(fresh.receipts.complete({ ...request, operationId: randomUUID() })).rejects.toThrow(
        "intent differs",
      );
      const conflicting = await fixture.open("conflicting-empty-authority");
      await expect(conflicting.receipts.complete({ ...request, operationId: randomUUID() })).rejects.toThrow(
        "intent differs",
      );
      expect(await fixture.storage.versions(key(request.accountId))).toEqual(versions);
      await fixture.storage.put(
        `accounts/${request.accountId}/backups/${randomUUID()}/archive.enc`,
        Buffer.from("opaque fixture archive"),
      );
      const other = `accounts/${randomUUID()}/backup.enc`;
      const retained = await fixture.storage.put(other, Buffer.from("other account fixture"));
      await fixture.storage.clean(`accounts/${request.accountId}/`);
      expect(await fixture.storage.versions(`accounts/${request.accountId}/`)).toEqual([]);
      expect(await fixture.storage.versions(key(request.accountId))).toEqual(versions);
      expect(await (await fixture.storage.get(other, retained.versionId)).text()).toBe("other account fixture");
      expect(await fresh.receipts.read(request)).toEqual(candidate);
      console.log(
        JSON.stringify({
          completionDurability: "passed",
          accountId: request.accountId,
          operationId: request.operationId,
          versionId: exactVersion.versionId,
          outage: "deliberate PUT503 transport fault",
          restart: "same timestamp",
          freshRoot: "canonical remote receipt",
          scope: "receipt durability; caller cleanup prerequisites excluded",
        }),
      );
    } catch (error) {
      failure = error;
    }
    try {
      await fixture.close();
    } catch (error) {
      throw new AggregateError([...(failure ? [failure] : []), error], "Completion durability cleanup failed");
    }
    if (failure) throw failure;
  },
  30_000,
);

test.skipIf(!enabled)(
  "a real conditional publication race adopts the existing completion time",
  async () => {
    const fixture = await receiptFixture();
    let failure: unknown;
    try {
      const owned = await fixture.open("authority");
      const request = intent();
      fixture.rejectWrites(true);
      await expect(owned.receipts.complete(request)).rejects.toThrow("503");
      const path = join(owned.folder.dir, "completions", `${request.accountId}.json`);
      const proposed = AccountPurgeCompletionSchema.parse(JSON.parse(await readFile(path, "utf8")));
      const canonical: AccountPurgeCompletion = {
        ...proposed,
        completedAt: new Date(Date.parse(proposed.completedAt) - 1).toISOString(),
      };
      fixture.publishBeforeWrite(canonical);
      fixture.rejectWrites(false);
      expect(await owned.receipts.complete(request)).toEqual(canonical);
      expect(fixture.conflicts()).toBe(1);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(canonical);
      const versions = await fixture.storage.versions(key(request.accountId));
      expect(versions).toHaveLength(1);
      const exact = versions[0];
      if (!exact) throw new Error("Canonical conditional receipt version is missing");
      expect(await (await fixture.storage.get(exact.key, exact.versionId)).json()).toEqual(canonical);
    } catch (error) {
      failure = error;
    }
    try {
      await fixture.close();
    } catch (error) {
      throw new AggregateError([...(failure ? [failure] : []), error], "Completion race cleanup failed");
    }
    if (failure) throw failure;
  },
  30_000,
);

test.skipIf(!enabled)(
  "completion reads reject oversized remote metadata and redirected local custody",
  async () => {
    const fixture = await receiptFixture();
    let failure: unknown;
    try {
      const owned = await fixture.open("authority");
      const request = intent();
      const completion = {
        format: "pocketcoder-account-purge-completion/v1",
        intent: request,
        completedAt: new Date().toISOString(),
      };
      await fixture.storage.put(
        key(request.accountId),
        Buffer.from(`${JSON.stringify(completion)}${" ".repeat(65_536)}`),
      );
      await expect(owned.receipts.read(request)).rejects.toThrow("metadata limit");
      const local = intent();
      const secret = join(fixture.root, "outside.json");
      await Bun.write(secret, JSON.stringify(completion));
      await symlink(secret, join(owned.folder.dir, "completions", `${local.accountId}.json`));
      await expect(owned.receipts.complete(local)).rejects.toThrow("private");
      expect(await Bun.file(secret).text()).toBe(JSON.stringify(completion));
      await chmod(secret, 0o600);
      const staged = intent();
      await link(secret, join(owned.folder.dir, "completions", `${staged.accountId}.json.tmp`));
      await expect(owned.receipts.complete(staged)).rejects.toThrow("private");
      expect(await Bun.file(secret).text()).toBe(JSON.stringify(completion));
      expect(await fixture.storage.versions(key(staged.accountId))).toEqual([]);
      const oversized = intent();
      await writeFile(
        join(owned.folder.dir, "completions", `${oversized.accountId}.json`),
        `${JSON.stringify(completion)}${" ".repeat(65_536)}`,
        { mode: 0o600 },
      );
      await expect(owned.receipts.read(oversized)).rejects.toThrow("private");
      const external = join(fixture.root, "external");
      await mkdir(external, { mode: 0o700 });
      await rename(join(owned.folder.dir, "completions"), join(owned.folder.dir, "old-completions"));
      await symlink(external, join(owned.folder.dir, "completions"));
      const redirected = intent();
      await expect(owned.receipts.complete(redirected)).rejects.toThrow("directory");
      expect(await fixture.storage.versions(key(redirected.accountId))).toEqual([]);
    } catch (error) {
      failure = error;
    }
    try {
      await fixture.close();
    } catch (error) {
      throw new AggregateError([...(failure ? [failure] : []), error], "Completion custody cleanup failed");
    }
    if (failure) throw failure;
  },
  30_000,
);
