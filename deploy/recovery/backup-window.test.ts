import { expect, test } from "bun:test";
import { backupWindow } from "./backup-window";

test("retries share a UTC recovery window and the next twelve-hour capture gets a new identity", () => {
  expect(backupWindow(new Date("2026-10-12T00:00:00Z"))).toBe("2026-10-12T00");
  expect(backupWindow(new Date("2026-10-12T11:59:59Z"))).toBe("2026-10-12T00");
  expect(backupWindow(new Date("2026-10-12T14:00:00+02:00"))).toBe("2026-10-12T12");
  expect(backupWindow(new Date("2026-10-13T00:00:00Z"))).toBe("2026-10-13T00");
});
