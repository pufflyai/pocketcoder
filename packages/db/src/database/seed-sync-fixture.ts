import { syncSeed } from "./data-folder";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Seed directory required");
await syncSeed(directory);
