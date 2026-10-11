import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPGliteFixture, insertTestWorkspace } from "../test-fixtures";
import { KEY_NAMES } from "./manifest";
import { verifyBackup } from "./verify-backup";
import { writeBackup } from "./write-backup";

test("runtime identities come from the archived database and omit delegated provider input", async () => {
  const f = await createPGliteFixture("pc93-runtime-snapshot", "disk");
  const directory = await mkdtemp(join(tmpdir(), "pc93-runtime-archive-"));
  try {
    const row = await insertTestWorkspace(f, "captured-runtime");
    const ref = {
      kind: "kubernetes",
      id: `pocketcoder-ws-${row.id}`,
      namespace: "pc93-account",
      jobUid: "2092bb84-ea5e-42b0-a0bc-af93c5d923ba",
      inputSecret: "workspace-input",
      egressSecret: "workspace-egress",
    };
    expect(
      await f.store.transition(row.id, {
        from: ["queued"],
        to: "provisioning",
        at: new Date(),
        patch: { providerKind: "kubernetes", providerRef: ref },
      }),
    ).not.toBeNull();
    expect(
      await f.store.transition(row.id, { from: ["provisioning"], to: "connected", at: new Date() }),
    ).not.toBeNull();
    await insertTestWorkspace(f, "queued-without-provider");
    const warm = randomUUID();
    await f.store.insertWarmPoolRuntime({
      id: warm,
      templateId: f.template.id,
      templateName: f.template.name,
      templateVersion: f.template.version,
      templateDigest: f.template.digest,
      driverKind: "kubernetes",
      eligibilityFingerprint: "fingerprint",
      state: "ready",
      providerRef: { ...ref, id: `pocketcoder-pool-${warm}`, poolRuntimeId: warm },
      enrollmentDigest: null,
      enrollmentExpiresAt: null,
      workspaceId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      readyAt: new Date(),
      leasedAt: null,
      failureCode: null,
    });
    const archive = join(directory, "backup.tar");
    const keys = Object.fromEntries(KEY_NAMES.map((name) => [name, randomBytes(32)])) as Record<
      (typeof KEY_NAMES)[number],
      Buffer
    >;
    await writeBackup(f.context, {
      output: archive,
      stagingReservationId: randomUUID(),
      keys,
      signal: new AbortController().signal,
      freeze: (capture) => capture(() => {}),
    });
    await f.store.updateWorkspace(row.id, { providerRef: { ...ref, jobUid: randomUUID() } }, new Date());
    expect(await f.store.transition(row.id, { from: ["connected"], to: "canceled", at: new Date() })).not.toBeNull();
    const { inputSecret: _input, egressSecret: _egress, ...identity } = ref;
    expect(await verifyBackup(archive)).toHaveProperty("runtimes", [
      { kind: "workspace", id: row.id, provider: "kubernetes", ref: identity },
      {
        kind: "warm",
        id: warm,
        provider: "kubernetes",
        ref: { ...identity, id: `pocketcoder-pool-${warm}`, poolRuntimeId: warm },
      },
    ]);
  } finally {
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("off-node capture refuses an unresolved launch before publication and retries after it settles", async () => {
  const f = await createPGliteFixture("pc93-unsettled-snapshot", "disk");
  const directory = await mkdtemp(join(tmpdir(), "pc93-unsettled-archive-"));
  try {
    const row = await insertTestWorkspace(f, "unsettled-provider");
    expect(await f.store.transition(row.id, { from: ["queued"], to: "provisioning", at: new Date() })).not.toBeNull();
    const options = {
      output: join(directory, "backup.tar"),
      stagingReservationId: randomUUID(),
      keys: Object.fromEntries(KEY_NAMES.map((name) => [name, randomBytes(32)])) as Record<
        (typeof KEY_NAMES)[number],
        Buffer
      >,
      signal: new AbortController().signal,
      freeze: <T>(capture: (check: () => void) => Promise<T>) => capture(() => {}),
    };
    await expect(writeBackup(f.context, options)).rejects.toThrow("Provider launches have not settled");
    expect(await readdir(directory)).toEqual([]);
    expect(await f.store.transition(row.id, { from: ["provisioning"], to: "queued", at: new Date() })).not.toBeNull();
    const warm = randomUUID();
    await f.store.insertWarmPoolRuntime({
      id: warm,
      templateId: f.template.id,
      templateName: f.template.name,
      templateVersion: f.template.version,
      templateDigest: f.template.digest,
      driverKind: "kubernetes",
      eligibilityFingerprint: "unsettled",
      state: "provisioning",
      providerRef: null,
      enrollmentDigest: null,
      enrollmentExpiresAt: null,
      workspaceId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      readyAt: null,
      leasedAt: null,
      failureCode: null,
    });
    await expect(writeBackup(f.context, options)).rejects.toThrow("Provider launches have not settled");
    expect(await readdir(directory)).toEqual([]);
    await f.store.updateWarmPoolRuntime(warm, { state: "failed" }, new Date());
    await writeBackup(f.context, options);
    expect((await verifyBackup(options.output)).runtimes).toEqual([]);
  } finally {
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
