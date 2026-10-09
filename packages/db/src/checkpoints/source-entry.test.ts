import { expect, test } from "bun:test";
import { chmodSync, lstatSync, lutimesSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpointCapture } from "./source-capture";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-capture-review-")));
  const source = join(directory, "source");
  const scratch = join(directory, "scratch");
  await mkdir(source);
  await mkdir(scratch, { mode: 0o700 });
  await mkdir(join(source, "parent"));
  await mkdir(join(source, "parent", "deep"));
  writeFileSync(join(source, "parent", "deep", "file"), Buffer.alloc(130049, 43));
  const policy = { name: "worktree", target: "/workspace", maxFiles: 3, maxBytes: 130049 };
  return { directory, source, scratch, policy, close: () => rm(directory, { recursive: true, force: true }) };
}
async function closed(baseline: number) {
  for (let i = 0; i < 30 && readdirSync("/dev/fd").length !== baseline; i++) await Bun.sleep(1);
  expect(readdirSync("/dev/fd").length).toBe(baseline);
}

test("last nonfile authority callback cannot invalidate already checked entry custody", async () => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  let armed = false;
  let changed = false;
  let capture: Awaited<ReturnType<typeof createCheckpointCapture>> | undefined;
  try {
    capture = await createCheckpointCapture([{ root: f.source, policy: f.policy }], {
      directory: f.scratch,
      maxIndexBytes: 100000,
      maxQueueBytes: 100000,
      check() {
        if (!armed) return;
        const stack = String(new Error().stack);
        if (
          !stack.includes("validateEntry") ||
          /captured|checkpointSourceParent|directory-reader|source-parent/.test(stack)
        )
          return;
        armed = false;
        changed = true;
        chmodSync(join(f.source, "parent"), 0o750);
      },
    });
    const entry = await capture.lookup(0, "parent");
    if (!entry) throw Error("Missing actual directory");
    armed = true;
    const validation = capture.validateEntry(entry);
    await validation.catch(() => {});
    expect(changed).toBe(true);
    expect(Number(lstatSync(join(f.source, "parent"), { bigint: true }).mode & 0o777n)).toBe(0o750);
    await expect(validation).rejects.toThrow("changed");
    await capture.close();
    await closed(baseline);
  } finally {
    await capture?.close().catch(() => {});
    await f.close();
  }
});

test("capture rejects symlink custody drift in source entry's final authority callback", async () => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  await rm(join(f.source, "parent"), { recursive: true, force: true });
  symlinkSync("missing", join(f.source, "link"));
  const original = lstatSync(join(f.source, "link"), { bigint: true });
  const rootOriginal = lstatSync(f.source, { bigint: true });
  let changed = false;
  let capture: Awaited<ReturnType<typeof createCheckpointCapture>> | undefined;
  try {
    const preparing = createCheckpointCapture([{ root: f.source, policy: { ...f.policy, maxFiles: 1, maxBytes: 7 } }], {
      directory: f.scratch,
      maxIndexBytes: 100000,
      maxQueueBytes: 100000,
      check() {
        if (changed) return;
        const stack = String(new Error().stack);
        if (!stack.includes("checkpointSourceEntry") || stack.includes("directory-reader")) return;
        changed = true;
        lutimesSync(join(f.source, "link"), new Date(), new Date("2000-01-01T00:00:00Z"));
      },
    });
    capture = await preparing.catch(() => undefined);
    expect(changed).toBe(true);
    expect(lstatSync(join(f.source, "link"), { bigint: true }).mtimeNs).not.toBe(original.mtimeNs);
    expect(lstatSync(f.source, { bigint: true }).ctimeNs).toBe(rootOriginal.ctimeNs);
    if (capture) expect((await capture.lookup(0, "link"))?.mtime_ns).toBe(String(original.mtimeNs));
    await expect(preparing).rejects.toThrow("changed");
    await capture?.close();
    await closed(baseline);
  } finally {
    await capture?.close().catch(() => {});
    await f.close();
  }
});
