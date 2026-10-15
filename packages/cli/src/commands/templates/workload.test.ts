import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseWorkloadTemplate } from "@pstdio/pocketcoder-contracts";
import { runCli } from "../../testing/cli-test-support";

const source = resolve(import.meta.dir, "../../../../../examples/workloads/finite-process.json");

test("CLI validates and renders canonical workloads without submitting work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-workload-render-"));
  try {
    const validated = await runCli(["templates", "validate", source]);
    expect(validated.exitCode).toBe(0);
    const rendered = await runCli(["templates", "render", source, "--out", directory]);
    expect(rendered.exitCode).toBe(0);
    const result = parseWorkloadTemplate(JSON.parse(await readFile(join(directory, "workload-fixture.json"), "utf8")));
    expect(result.manifest.apiVersion).toBe("pocketcoder.dev/v1");
    expect(result.manifest.spec.version).toMatch(/^1\.0\.0-[a-f0-9]{12}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
