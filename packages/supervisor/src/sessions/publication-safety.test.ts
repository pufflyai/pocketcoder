import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelope } from "./fixture.test";
import { SessionProducer, type SessionRun } from "./producer";

test.each([
  { name: "traversal", path: "outputs/../secret.txt", filename: "safe.txt" },
  { name: "outside root", path: "secret.txt", filename: "safe.txt" },
  { name: "file symlink", path: "outputs/file-link", filename: "safe.txt" },
  { name: "directory symlink", path: "outputs/directory-link/secret.txt", filename: "safe.txt" },
  { name: "hard link", path: "outputs/hard-link", filename: "safe.txt" },
  { name: "directory", path: "outputs/folder", filename: "safe.txt" },
  { name: "special file", path: "outputs/pipe", filename: "safe.txt" },
  { name: "byte overflow", path: "outputs/large", filename: "safe.txt" },
  { name: "unsafe filename", path: "outputs/safe.txt", filename: "../secret.txt" },
  { name: "root symlink", path: "root-link/outputs/safe.txt", filename: "safe.txt", policyRoot: "root-link" },
  {
    name: "root ancestor symlink",
    path: "root-link/outputs/safe.txt",
    filename: "safe.txt",
    policyRoot: "root-link/outputs",
  },
])("native publication rejects $name without staging bytes", async ({ path, filename, policyRoot = "outputs" }) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-publication-safety-")));
  const output = join(directory, "outputs");
  await mkdir(join(output, "folder"), { recursive: true });
  await writeFile(join(directory, "secret.txt"), "secret");
  await writeFile(join(output, "safe.txt"), "safe");
  await writeFile(join(output, "large"), "123456789");
  await symlink(join(directory, "secret.txt"), join(output, "file-link"));
  await symlink(directory, join(output, "directory-link"));
  await symlink(directory, join(directory, "root-link"));
  await link(join(directory, "secret.txt"), join(output, "hard-link"));
  expect(Bun.spawnSync(["mkfifo", join(output, "pipe")]).exitCode).toBe(0);
  const producer = new SessionProducer(join(directory, "journal"), async (run) => {
    if (!run.publishFile) throw new Error("Missing publication capability");
    // Preserve '..' so the selected input reaches the boundary unchanged.
    const selection = { path: `${directory}/${path}`, name: filename, mediaType: "text/plain" };
    expect(() => run.publishFile?.(selection)).toThrow();
  });
  const input = { ...envelope(), publicationPolicy: { roots: [join(directory, policyRoot)], bytes: 8, files: 2 } };
  try {
    await producer.accept(input);
    await producer.quiesce();
    expect(await producer.lookup(input.acceptance.execution)).toMatchObject({
      outcome: { status: "completed" },
      publication: { complete: true, objects: [] },
    });
  } finally {
    await producer.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stopped native request cannot publish again and keeps its selected bytes as partial", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-publication-cancel-")));
  const path = join(directory, "report.txt");
  await writeFile(path, "done");
  let publish: SessionRun["publishFile"];
  const producer = new SessionProducer(join(directory, "journal"), async (run) => {
    publish = run.publishFile;
    if (!publish) throw new Error("Missing publication capability");
    publish({ path, mediaType: "text/plain" });
    return "canceled";
  });
  const input = { ...envelope(), publicationPolicy: { roots: [directory], bytes: 8, files: 1 } };
  try {
    await producer.accept(input);
    await producer.quiesce();
    expect(await producer.lookup(input.acceptance.execution)).toMatchObject({
      phase: "canceled",
      publication: { complete: false, objects: [{ name: "report.txt" }] },
    });
    expect(() => publish?.({ path, mediaType: "text/plain" })).toThrow("no longer running");
  } finally {
    await producer.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
