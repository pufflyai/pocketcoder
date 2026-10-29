import { describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL } from "@pstdio/pocketcoder-db/testing";
import { SQL } from "bun";
import { runCli } from "../../testing/cli-test-support";

describe.skipIf(!TEST_DATABASE_URL)("pcd db", () => {
  test("migrate applies pending migrations once and status lists them", async () => {
    const schema = `pc_cli_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const env = { POCKETCODER_DATABASE_URL: TEST_DATABASE_URL, POCKETCODER_DATABASE_SCHEMA: schema };
    const sql = new SQL(TEST_DATABASE_URL as string, { max: 1 });
    try {
      const pending = await runCli(["db", "status"], { env });
      expect(pending.exitCode).toBe(0);
      expect(pending.output).toContain("pending");
      const first = await runCli(["db", "migrate"], { env });
      expect(first.exitCode).toBe(0);
      expect(first.output).toContain("applied:");
      const again = await runCli(["db", "migrate"], { env });
      expect(again.output).toContain("database is up to date");
      const status = await runCli(["db", "status"], { env });
      expect(status.output).not.toContain("pending");
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  test("migrate explains a missing database URL", async () => {
    const result = await runCli(["db", "migrate"], { env: { POCKETCODER_DATABASE_URL: undefined } });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("POCKETCODER_DATABASE_URL is required");
  });
});
