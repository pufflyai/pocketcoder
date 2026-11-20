import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPressure } from "./native-startup-sample";

test("pressure sampling distinguishes missing kernel metrics from real counters and read failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc195-pressure-"));
  try {
    const file = join(directory, "cpu");
    await writeFile(file, "some avg10=0.00 avg60=0.25 avg300=0.50 total=123\n");
    expect(await readPressure(file)).toEqual([
      { kind: "some", values: { avg10: 0, avg60: 0.25, avg300: 0.5, total: 123 } },
    ]);
    expect(await readPressure(join(directory, "missing"))).toBeNull();
    await expect(readPressure(join(file, "child"))).rejects.toMatchObject({ code: "ENOTDIR" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
