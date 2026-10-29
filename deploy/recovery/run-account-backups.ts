import { readPrivateFile } from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import { backupAccounts } from "./account-backups";

const [path] = process.argv.slice(2);
if (!path) throw new Error("Usage: bun deploy/recovery/run-account-backups.ts PRIVATE_CONFIG_PATH");
const config = z
  .strictObject({ managerUrl: z.url(), tokenFile: z.string() })
  .parse(JSON.parse((await readPrivateFile(path, 4096)).toString()));
try {
  console.log(JSON.stringify(await backupAccounts(config)));
} catch (error) {
  if (error instanceof AggregateError) for (const cause of error.errors) console.error(String(cause));
  throw error;
}
