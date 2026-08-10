import { describe, expect, test } from "bun:test";
import { formatMigrationStatus } from "./status";

describe("database command", () => {
  test("formats pending, applied, and drifted migrations", () => {
    expect(
      formatMigrationStatus([
        { name: "001_initial", appliedAt: null, drifted: false },
        { name: "002_more", appliedAt: new Date("2026-08-10T12:00:00.000Z"), drifted: false },
        { name: "003_changed", appliedAt: new Date("2026-08-10T12:01:00.000Z"), drifted: true },
      ]),
    ).toEqual([
      "001_initial\tpending",
      "002_more\tapplied 2026-08-10T12:00:00.000Z",
      "003_changed\tDRIFTED",
    ]);
  });
});
