import { expect, test } from "bun:test";
import { healthyHeartbeatBaseline } from "./monitoring-heartbeat";

test("a transient alert cannot become the baseline for an injected heartbeat fault", () => {
  expect(healthyHeartbeatBaseline({ missing: 0, oldest: 30.274, alert: 1 })).toBe(false);
  expect(healthyHeartbeatBaseline({ missing: 1, oldest: 0, alert: Number.NaN })).toBe(false);
  expect(healthyHeartbeatBaseline({ missing: 0, oldest: 60, alert: Number.NaN })).toBe(false);
  expect(healthyHeartbeatBaseline({ missing: 0, oldest: 30.274, alert: Number.NaN })).toBe(true);
});
