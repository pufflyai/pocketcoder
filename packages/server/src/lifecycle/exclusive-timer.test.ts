// Proves controller shutdown joins an already admitted retention task.
import { expect, test } from "bun:test";
import { startExclusiveTimer } from "./exclusive-timer";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("timer shutdown waits for the admitted task and refuses another tick", async () => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  let settled = false;
  const owner = startExclusiveTimer(
    1,
    async () => {
      calls += 1;
      entered.resolve();
      await release.promise;
    },
    "retention",
    () => {},
  );
  try {
    await entered.promise;
    const stopping = owner.stop().then(() => {
      settled = true;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    expect(calls).toBe(1);
    release.resolve();
    await stopping;
    expect(settled).toBe(true);
    await Bun.sleep(5);
    expect(calls).toBe(1);
  } finally {
    release.resolve();
    await owner.stop();
  }
});
