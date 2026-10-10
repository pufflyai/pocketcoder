import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../http/middleware";
import { createMaintenance, maintenanceGate } from "./maintenance";

test("a window refuses new writes with a retry hint while reads and paused ticks continue", async () => {
  const maintenance = createMaintenance();
  const app = new Hono<AppEnv>();
  app.use("*", maintenanceGate(maintenance));
  app.get("/read", (c) => c.text("ok"));
  app.post("/write", (c) => c.text("done"));
  let ticks = 0;
  const tick = maintenance.pausable(async () => {
    ticks += 1;
  });

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const window = maintenance.run(5000, new AbortController().signal, () => held);
  const refused = await app.request("/write", { method: "POST" });
  expect(refused.status).toBe(503);
  expect(refused.headers.get("retry-after")).toBe("1");
  expect(await refused.json()).toMatchObject({ error: { code: "maintenance.active" } });
  expect(await (await app.request("/read")).text()).toBe("ok");
  await tick();
  expect(ticks).toBe(0);

  release();
  await window;
  expect(await (await app.request("/write", { method: "POST" })).text()).toBe("done");
  await tick();
  expect(ticks).toBe(1);
});

test("a caller leaving during settling ends the window without running its step", async () => {
  const maintenance = createMaintenance();
  let finish!: () => void;
  const admitted = maintenance.admit(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const caller = new AbortController();
  let ran = false;
  const window = maintenance.run(5000, caller.signal, async () => {
    ran = true;
  });
  caller.abort(new Error("caller left"));
  await expect(window).rejects.toThrow("caller left");
  expect(ran).toBe(false);
  expect(maintenance.active).toBe(false);
  finish();
  await admitted;
});

test("a timed-out window stops settling instead of draining later traffic", async () => {
  const maintenance = createMaintenance();
  let settled = 0;
  maintenance.settleWith(async () => {
    settled += 1;
  });
  let finish!: () => void;
  const stuck = maintenance.admit(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await expect(maintenance.run(50, new AbortController().signal, async () => {})).rejects.toMatchObject({
    code: "maintenance.timeout",
  });
  finish();
  await stuck;
  await Bun.sleep(10);
  expect(settled).toBe(0);
});
