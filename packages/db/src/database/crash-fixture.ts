import { getMigrationStatus } from "../migrations/migrator";
import { PGliteStore } from "../store";
import { createDatabaseContext } from "./context";
import { lockDataFolder } from "./data-folder";

const [command, dir] = process.argv.slice(2);
if (!dir) throw new Error("data directory required");
if (command === "lock") {
  lockDataFolder(dir);
  console.log("locked");
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
} else if (command === "write") {
  const store = await PGliteStore.create(dir);
  console.log(JSON.stringify({ peakKiB: process.resourceUsage().maxRSS }));
  for (let index = 0; ; index++) {
    const principal = await store.createPrincipal(`crash-${index}`, ["admin"], ["*"]);
    console.log(JSON.stringify({ id: principal.id, name: principal.name }));
  }
} else if (command === "inspect") {
  const context = await createDatabaseContext(dir);
  try {
    console.log(
      JSON.stringify({
        principals: await context.db.select().from(context.tables.principals),
        migrations: await getMigrationStatus(context.client),
        peakKiB: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    await context.close();
  }
} else {
  throw new Error("unknown fixture command");
}
