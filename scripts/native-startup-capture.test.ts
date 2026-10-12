import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureStartup } from "./native-startup-capture";

test.skipIf(process.platform !== "linux")(
  "a real failed child leaves terminal sampling files and no live sampler",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pc105-sampler-cleanup-"));
    try {
      const result = await captureStartup(
        [
          process.execPath,
          "-e",
          'console.log("first-result"); console.error("first-log"); setTimeout(() => process.exit(7), 250);',
        ],
        directory,
      );
      expect(result.exitCode).toBe(7);
      expect(result.samples).toBeGreaterThan(0);
      expect(result.sampler).toEqual({ running: false, closed: true });
      expect(result.samplingError).toBeUndefined();
      expect(await Bun.file(`/proc/${result.pid}/stat`).exists()).toBe(false);
      expect(await Bun.file(join(directory, "result.json")).text()).toBe("first-result\n");
      expect(await Bun.file(join(directory, "controller.log")).text()).toBe("first-log\n");
      const path = join(directory, "samples.jsonl");
      const content = await Bun.file(path).text();
      const records = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records).toHaveLength(result.samples);
      expect(records[0].processes[0].pid).toBe(result.pid);
      expect(records[0].cpu[0].values.every(Number.isFinite)).toBe(true);
      expect(records[0].pressure.cpu[0].values.total).toBeGreaterThanOrEqual(0);
      await Bun.sleep(200);
      expect(await Bun.file(path).text()).toBe(content);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
