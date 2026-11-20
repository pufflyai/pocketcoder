import { expect, test } from "bun:test";
import { startCheckpoints } from "./checkpoints";

test("serializes periodic evidence and stops in-flight work before final uploads", async () => {
  const captured: number[] = [];
  let active = 0;
  let overlap = false;
  const checkpoints = startCheckpoints(async (signal) => {
    active++;
    overlap ||= active > 1;
    await Bun.sleep(15);
    if (!signal.aborted) captured.push(Date.now());
    active--;
  }, 5);
  await Bun.sleep(55);
  await checkpoints.stop();
  const count = captured.length;
  await Bun.sleep(20);
  expect(overlap).toBe(false);
  expect(count).toBeGreaterThan(0);
  expect(captured.length).toBe(count);
  expect(active).toBe(0);
});
