import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpointCapture } from "./source-capture";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-capture-")));
  const source = join(root, "source");
  const directory = join(root, "scratch");
  await mkdir(source);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(source, "z"));
  await mkdir(join(source, "z", "empty"));
  const bytes = Buffer.alloc(131_071, 77);
  writeFileSync(join(source, "a"), bytes);
  writeFileSync(join(source, "z", "content"), Buffer.alloc(99, 23));
  await symlink("../a", join(source, "z", "link"));
  await symlink("missing", join(source, "deadlink"));
  const logicalBytes = bytes.length + 99 + 4 + 7;
  const policy = { name: "worktree", target: "/workspace", maxFiles: 6, maxBytes: logicalBytes };
  const options = { directory, maxIndexBytes: 1_000_000, maxQueueBytes: 1_000_000, check() {} };
  return {
    root,
    source,
    directory,
    bytes,
    logicalBytes,
    policy,
    options,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("actual native capture sorts a complete tree and reopens only captured regular content", async () => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  let capture: Awaited<ReturnType<typeof createCheckpointCapture>> | undefined;
  try {
    capture = await createCheckpointCapture([{ root: f.source, policy: f.policy }], f.options);
    const entries = [];
    for await (const entry of capture.entries()) entries.push(entry);
    expect(entries.map((entry) => entry.path)).toEqual(["a", "deadlink", "z", "z/content", "z/empty", "z/link"]);
    expect(capture.mounts).toEqual([{ name: "worktree", logical_bytes: f.logicalBytes, file_count: 6 }]);
    const entry = await capture.lookup(0, "a");
    if (!entry) throw new Error("Expected captured file");
    expect(entry.kind).toBe("file");
    expect(entry).toHaveProperty("digest", `sha256:${createHash("sha256").update(f.bytes).digest("hex")}`);
    expect(Buffer.from(await new Response(await capture.openPayload(entry)).arrayBuffer())).toEqual(f.bytes);
    expect(readdirSync(f.directory)).toEqual([]);
    await capture.close();
    expect(readdirSync("/dev/fd").length).toBe(baseline);
  } finally {
    await capture?.close();
    await f.close();
  }
});

test.each(["content", "parent"])("capture refuses a real later %s change before opening its payload", async (kind) => {
  const f = await fixture();
  let capture: Awaited<ReturnType<typeof createCheckpointCapture>> | undefined;
  try {
    capture = await createCheckpointCapture([{ root: f.source, policy: f.policy }], f.options);
    const entry = await capture.lookup(0, "z/content");
    if (!entry) throw new Error("Expected captured nested file");
    if (kind === "content") writeFileSync(join(f.source, "z", "content"), Buffer.alloc(99, 44));
    else await mkdir(join(f.source, "z", "late"));
    await expect(capture.openPayload(entry)).rejects.toThrow("changed");
  } finally {
    await capture?.close();
    await f.close();
  }
});

test("filesystem root capture refuses descendant scratch before any allocation or host scan", async () => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  try {
    await expect(
      createCheckpointCapture([{ root: "/", policy: { ...f.policy, maxFiles: 1, maxBytes: 1 } }], {
        ...f.options,
        // A zero queue reservation prevents host traversal if containment regresses.
        maxQueueBytes: 0,
      }),
    ).rejects.toThrow("outside captured mounts");
    expect(readdirSync("/dev/fd").length).toBe(baseline);
    expect(readdirSync(f.directory)).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each(["files", "bytes", "scratch"])(
  "native capture enforces its actual %s reservation and drains failures",
  async (kind) => {
    const f = await fixture();
    const baseline = readdirSync("/dev/fd").length;
    try {
      const policy = { ...f.policy };
      const options = { ...f.options };
      if (kind === "files") policy.maxFiles--;
      if (kind === "bytes") policy.maxBytes--;
      if (kind === "scratch") options.maxIndexBytes = 1;
      await expect(createCheckpointCapture([{ root: f.source, policy }], options)).rejects.toThrow();
      expect(readdirSync("/dev/fd").length).toBe(baseline);
      expect(readdirSync(f.directory)).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

test("a real timer can cancel a wide capture without retaining native descriptors", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const baseline = readdirSync("/dev/fd").length;
  for (let i = 0; i < 512; i++) writeFileSync(join(f.source, `empty-${i}`), "");
  const timer = setTimeout(() => abort.abort(new Error("capture purged")), 0);
  try {
    await expect(
      createCheckpointCapture([{ root: f.source, policy: { ...f.policy, maxFiles: 10_000_000 } }], {
        ...f.options,
        signal: abort.signal,
      }),
    ).rejects.toThrow("capture purged");
    expect(readdirSync("/dev/fd").length).toBe(baseline);
    expect(readdirSync(f.directory)).toEqual([]);
  } finally {
    clearTimeout(timer);
    await f.close();
  }
});

test("deep capture keeps a fixed descriptor budget while reopening captured parents", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-deep-capture-")));
  const source = join(root, "source");
  const directory = join(root, "scratch");
  await mkdir(source);
  await mkdir(directory, { mode: 0o700 });
  const parts = Array.from({ length: 48 }, (_, index) => `parent-${index}`);
  let parent = source;
  for (const part of parts) {
    parent = join(parent, part);
    await mkdir(parent);
  }
  writeFileSync(join(parent, "file"), "contents");
  const baseline = readdirSync("/dev/fd").length;
  let peak = baseline;
  let capture: Awaited<ReturnType<typeof createCheckpointCapture>> | undefined;
  try {
    capture = await createCheckpointCapture(
      [{ root: source, policy: { name: "deep", target: "/workspace", maxBytes: 8, maxFiles: 49 } }],
      {
        directory,
        maxIndexBytes: 1_000_000,
        maxQueueBytes: 1_000_000,
        check() {
          peak = Math.max(peak, readdirSync("/dev/fd").length);
        },
      },
    );
    const entry = await capture.lookup(0, `${parts.join("/")}/file`);
    if (!entry) throw new Error("Expected deep captured file");
    expect(await new Response(await capture.openPayload(entry)).text()).toBe("contents");
    expect(capture.mounts[0]?.file_count).toBe(49);
    expect(peak).toBeLessThanOrEqual(baseline + 10);
    await capture.close();
    expect(readdirSync("/dev/fd").length).toBe(baseline);
  } finally {
    await capture?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["opening", "locked"])("capture close drains a real payload while %s", async (stage) => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  let armed = false;
  let closing: Promise<void> | undefined;
  let capture: Awaited<ReturnType<typeof createCheckpointCapture>> | undefined;
  try {
    capture = await createCheckpointCapture([{ root: f.source, policy: f.policy }], {
      ...f.options,
      check() {
        if (armed) {
          armed = false;
          closing = capture?.close();
        }
      },
    });
    const entry = await capture.lookup(0, "a");
    if (!entry) throw new Error("Expected captured file");
    if (stage === "opening") {
      armed = true;
      await expect(capture.openPayload(entry)).rejects.toThrow("closed");
    } else {
      const reader = (await capture.openPayload(entry)).getReader();
      try {
        closing = capture.close();
        await expect(reader.read()).rejects.toThrow("closed");
      } finally {
        reader.releaseLock();
      }
    }
    await closing;
    expect(readdirSync("/dev/fd").length).toBe(baseline);
    expect(readdirSync(f.directory)).toEqual([]);
  } finally {
    await capture?.close();
    await f.close();
  }
});
