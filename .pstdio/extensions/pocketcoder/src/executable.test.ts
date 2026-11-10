import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutable } from "./executable";
import { createInstances } from "./instances";

test("uses the project's native build when pocketcoder is absent from the desktop PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-executable-"));
  try {
    await mkdir(join(root, "out/native"), { recursive: true });
    await symlink(process.execPath, join(root, "out/native/pocketcoder"));
    expect(await resolveExecutable({ projectRoot: root, searchPath: root })).toBe(join(root, "out/native/pocketcoder"));
    expect(await resolveExecutable({ binary: "pocketcoder", projectRoot: root, searchPath: root })).toBe(
      join(root, "out/native/pocketcoder"),
    );
    expect(await resolveExecutable({ binary: "out/native/pocketcoder", projectRoot: root, searchPath: root })).toBe(
      join(root, "out/native/pocketcoder"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing executable explains how to build it and leaves no saved instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-missing-executable-"));
  try {
    await expect(resolveExecutable({ projectRoot: root, searchPath: root })).rejects.toThrow("bun run build:native");
    await expect(createInstances(root).launch({ name: "missing", binary: join(root, "missing") })).rejects.toThrow(
      "executable",
    );
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one saved instance with a missing executable does not break the instance list", async () => {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-invalid-instance-"));
  const id = crypto.randomUUID();
  try {
    await mkdir(join(root, id));
    await writeFile(join(root, id, "empty.env"), "");
    await writeFile(
      join(root, id, "instance.json"),
      JSON.stringify({
        id,
        name: "Broken launch",
        binary: join(root, "missing"),
        url: "http://127.0.0.1:1",
        agentPort: 2,
        state: "stopped",
      }),
    );
    const instances = await createInstances(root).list();
    expect(instances[0]?.state).toBe("stopped");
    expect(instances[0]?.error).toContain("executable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
