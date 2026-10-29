import { expect, test } from "bun:test";
import { serialAccountWork } from "./serial-work";

test("recovery waits for its account worker, while another account keeps moving", async () => {
  const work = serialAccountWork();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];
  const worker = work.run("one", async () => {
    entered.resolve();
    await release.promise;
    events.push("worker stopped");
    throw new Error("failed replacement");
  });
  worker.catch(() => {});
  await entered.promise;
  const recovery = work.run("one", async () => {
    events.push("recovery");
  });
  await work.run("two", async () => {
    events.push("other account");
  });
  expect(events).toEqual(["other account"]);
  release.resolve();
  await expect(worker).rejects.toThrow("failed replacement");
  await recovery;
  await work.drain();
  expect(events).toEqual(["other account", "worker stopped", "recovery"]);
});
