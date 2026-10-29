import { expect, test } from "bun:test";
import { fstatSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
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
function openInode(ino: bigint) {
  return readdirSync("/dev/fd").some((name) => {
    try {
      return fstatSync(Number(name), { bigint: true }).ino === ino;
    } catch {
      return false;
    }
  });
}
async function closed(baseline: number) {
  for (let i = 0; i < 30 && readdirSync("/dev/fd").length !== baseline; i++) await Bun.sleep(1);
  expect(readdirSync("/dev/fd").length).toBe(baseline);
}

test.each(["opening", "reading"])("original closed parent drift refuses descendant payload while %s", async (stage) => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  const parent = lstatSync(join(f.source, "parent"), { bigint: true });
  const deep = lstatSync(join(f.source, "parent", "deep"), { bigint: true });
  let armed = false;
  let mutated = false;
  let capture: Awaited<ReturnType<typeof createCheckpointCapture>> | undefined;
  try {
    capture = await createCheckpointCapture([{ root: f.source, policy: f.policy }], {
      directory: f.scratch,
      maxIndexBytes: 100000,
      maxQueueBytes: 100000,
      check() {
        if (!armed || openInode(parent.ino) || !openInode(deep.ino)) return;
        armed = false;
        mutated = true;
        writeFileSync(join(f.source, "parent", "late"), "late uncheckpointed content");
      },
    });
    const entry = await capture.lookup(0, "parent/deep/file");
    if (!entry) throw Error("Missing real file");
    if (stage === "opening") {
      armed = true;
      await expect(capture.openPayload(entry)).rejects.toThrow("changed");
    } else {
      const reader = (await capture.openPayload(entry)).getReader();
      try {
        expect((await reader.read()).value?.byteLength).toBe(65_536);
        armed = true;
        await expect(reader.read()).rejects.toThrow("changed");
      } finally {
        reader.releaseLock();
      }
    }
    expect(mutated).toBe(true);
    expect(lstatSync(join(f.source, "parent"), { bigint: true }).ctimeNs).not.toBe(parent.ctimeNs);
    expect(lstatSync(join(f.source, "parent", "deep"), { bigint: true }).ctimeNs).toBe(deep.ctimeNs);
    await capture.close();
    await closed(baseline);
  } finally {
    await capture?.close().catch(() => {});
    await f.close();
  }
});
