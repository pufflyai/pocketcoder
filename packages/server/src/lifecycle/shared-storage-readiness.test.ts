import { expect, test } from "bun:test";
import { Readiness } from "../observability/health";
import { SHARED_STORAGE_FAILURE_GRACE_MS, sharedStorageReadiness } from "./shared-storage-readiness";

function fixture() {
  const readiness = new Readiness();
  let now = Date.parse("2026-11-04T08:00:00Z");
  let failure: Error | null = null;
  const tick = sharedStorageReadiness(
    async () => {
      if (failure) throw failure;
    },
    readiness,
    () => new Date(now),
  );
  return {
    readiness,
    tick: () => tick().catch(() => {}),
    fail: (error: Error | null) => {
      failure = error;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("shared storage is pending until its first check passes", async () => {
  const f = fixture();
  expect(f.readiness.snapshot().checks["shared-storage"]).toBe("pending");
  await f.tick();
  expect(f.readiness.snapshot()).toMatchObject({ ok: true, checks: { "shared-storage": "ok" } });
});

test("a brief shared storage outage keeps the controller ready", async () => {
  const f = fixture();
  await f.tick();
  f.fail(new Error("storage server timed out"));
  await f.tick();
  f.advance(SHARED_STORAGE_FAILURE_GRACE_MS - 1);
  await f.tick();
  expect(f.readiness.snapshot().ok).toBe(true);
});

test("a lasting shared storage outage fails readiness with its cause until storage recovers", async () => {
  const f = fixture();
  await f.tick();
  f.fail(new Error("NFS endpoint is not isolated from workloads"));
  await f.tick();
  f.advance(SHARED_STORAGE_FAILURE_GRACE_MS);
  await f.tick();
  expect(f.readiness.snapshot()).toMatchObject({
    ok: false,
    checks: { "shared-storage": "failed" },
    reasons: { "shared-storage": "NFS endpoint is not isolated from workloads" },
  });

  f.fail(null);
  await f.tick();
  expect(f.readiness.snapshot()).toEqual(expect.objectContaining({ ok: true }));
  expect(f.readiness.snapshot().reasons).toBeUndefined();
});
