import { expect, test } from "bun:test";
import { issuerBackoff } from "./issuer-backoff";

test("leaving a session removes its retry window", async () => {
  const retry = issuerBackoff();
  await expect(
    retry.run("workspace:session:1", async () => {
      throw new Error("outage");
    }),
  ).rejects.toThrow("outage");
  retry.forget("workspace:session:");
  expect(await retry.run("workspace:session:1", async () => "fresh")).toBe("fresh");
});

test("an abandoned retry window expires without another call from that session", async () => {
  const retry = issuerBackoff(Date.now, 5);
  const fail = () =>
    retry.run("abandoned", async () => {
      throw new Error("outage");
    });
  await expect(fail()).rejects.toThrow("outage");
  await Bun.sleep(1030);
  await expect(fail()).rejects.toThrow("outage");
  await Bun.sleep(1030);
  expect(await retry.run("abandoned", async () => "fresh")).toBe("fresh");
});
