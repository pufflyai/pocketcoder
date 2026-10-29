import { getMigrationStatus } from "../migrations/migrator";
import { DatabaseStore } from "../store";
import { inspectAdmission } from "./admission-fixture";
import { lockDataFolder } from "./data-folder";
import { createPGliteContext } from "./pglite-context";

const [command, dir] = process.argv.slice(2);
if (!dir) throw new Error("data directory required");
if (command === "lock") {
  lockDataFolder(dir);
  console.log("locked");
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
} else if (command === "write") {
  const store = await DatabaseStore.openPGlite(dir);
  console.log(JSON.stringify({ peakKiB: process.resourceUsage().maxRSS }));
  for (let index = 0; ; index++) {
    const principal = await store.createPrincipal(`crash-${index}`, ["admin"], ["*"]);
    console.log(JSON.stringify({ id: principal.id, name: principal.name }));
  }
} else if (command === "inspect" || command === "verify") {
  const context = await createPGliteContext(dir);
  try {
    console.log(
      JSON.stringify({
        principals: await context.db.select().from(context.tables.principals),
        migrations: await getMigrationStatus(context.sql),
        admission: command === "verify" ? await inspectAdmission(new DatabaseStore(context)) : undefined,
        peakKiB: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    await context.close();
  }
} else {
  throw new Error("unknown fixture command");
}
