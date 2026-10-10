import { randomBytes } from "node:crypto";
import { createDatabaseContext } from "../database/context";
import { verifyBackup } from "./verify-backup";
import { writeBackup } from "./write-backup";

const [command, dir, output] = process.argv.slice(2);
if (!dir || !output) throw new Error("data directory and output required");
if (command === "fill") {
  const context = await createDatabaseContext(dir);
  await context.client.exec("CREATE TABLE filler (body bytea)");
  // Random bytes do not compress, so the database files grow by the full amount.
  for (let index = 0; index < 128; index++)
    await context.client.query("INSERT INTO filler (body) VALUES ($1)", [randomBytes(1024 ** 2)]);
  await context.close();
} else if (command === "backup") {
  const context = await createDatabaseContext(dir);
  const opened = process.resourceUsage().maxRSS;
  const receipt = await writeBackup(context, {
    output,
    keys: { "auth-pepper": randomBytes(32), "event-signing-key": randomBytes(32), "secret-key": randomBytes(32) },
    signal: new AbortController().signal,
    freeze: (capture) => capture(() => {}),
  });
  await context.close();
  console.log(JSON.stringify({ openedKiB: opened, peakKiB: process.resourceUsage().maxRSS, bytes: receipt.bytes }));
} else if (command === "verify") {
  await verifyBackup(output);
  console.log(JSON.stringify({ peakKiB: process.resourceUsage().maxRSS }));
} else {
  throw new Error("unknown fixture command");
}
