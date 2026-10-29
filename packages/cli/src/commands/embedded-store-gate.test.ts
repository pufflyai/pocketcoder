import { expect, test } from "bun:test";
import { runCli } from "../testing/cli-test-support";

const postgres = { POCKETCODER_DATABASE_URL: "postgres://pc@127.0.0.1:1/pocketcoder" };

test.each([
  [["backup", "create", "--out", "/tmp/never.tar"], "pcd backup"],
  [["backup", "verify", "/tmp/never.tar"], "pcd backup"],
  [["backup", "restore", "/tmp/never.tar", "--dir", "/tmp/never"], "pcd backup"],
  [["backup", "create-off-node", "--operation-id", "op"], "pcd backup"],
  [["recovery", "status"], "pcd recovery"],
  [["recovery", "complete"], "pcd recovery"],
])("%p refuses with PostgreSQL", async (args, command) => {
  const result = await runCli(args, { env: postgres });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(`${command} is not available with PostgreSQL. Use your database's backups instead.`);
});

test("a local key revoke on PostgreSQL needs the deletion journal", async () => {
  const result = await runCli(["keys", "revoke", "--id", crypto.randomUUID()], { env: postgres });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("POCKETCODER_JOURNAL_DIR");
});
