import { expect, test } from "bun:test";
import { endSessionAt } from "./expiry";

test("expiration closes the run, while normal exit cancels scheduled cleanup", async () => {
  let closes = 0;
  const deadline = new Date(Date.now() + 10);
  endSessionAt(deadline, () => {
    closes += 1;
  });
  const cancel = endSessionAt(deadline, () => {
    closes += 1;
  });
  cancel();
  await Bun.sleep(30);
  expect(closes).toBe(1);
});
