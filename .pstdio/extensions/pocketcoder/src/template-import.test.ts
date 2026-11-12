import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { instanceLimits } from "./instance-inputs";
import { snapshotTemplateImport } from "./template-import";

test("directory import validates and publishes the same private snapshot", async () => {
  const source = await mkdtemp(join(tmpdir(), "pc-template-source-"));
  let snapshot: Awaited<ReturnType<typeof snapshotTemplateImport>> | undefined;
  try {
    const manifest = await Bun.file(
      resolve(import.meta.dir, "../../../../examples/workloads/finite-process.json"),
    ).json();
    const capacity = instanceLimits([manifest]);
    await writeFile(join(source, "a.json"), JSON.stringify(manifest));
    snapshot = await snapshotTemplateImport(source, capacity);
    const oversized = structuredClone(manifest);
    oversized.spec.limits.inputFiles++;
    await writeFile(join(source, "a.json"), JSON.stringify(oversized));
    await writeFile(join(source, "b.json"), JSON.stringify(oversized));
    expect(await readdir(snapshot.directory)).toEqual(["a.json"]);
    expect(await Bun.file(join(snapshot.directory, "a.json")).json()).toEqual(manifest);
    expect((await stat(snapshot.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(snapshot.directory, "a.json"))).mode & 0o777).toBe(0o600);
    await expect(snapshotTemplateImport(source, capacity)).rejects.toThrow("Launch a new instance");
    await snapshot.dispose();
    expect(await Bun.file(join(snapshot.directory, "a.json")).exists()).toBe(false);
  } finally {
    await snapshot?.dispose();
    await rm(source, { recursive: true, force: true });
  }
});
