import { readdir } from "node:fs/promises";
import { join } from "node:path";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Usage: native-startup-sync-order.ts <first-start-trace-directory>");

const calls: { operation: string; path: string; start: number; end: number }[] = [];
for (const name of await readdir(directory)) {
  if (!name.startsWith("waits.")) continue;
  for (const line of (await Bun.file(join(directory, name)).text()).split("\n")) {
    const match = line.match(/^(\d+):(\d+):(\d+\.\d+) (fchmod|fsync)\(\d+<([^>]+)>.*= 0 <(\d+\.\d+)>$/);
    if (!match) continue;
    const [, hours, minutes, seconds, operation, path, duration] = match;
    if (!operation || !path || !/\/pc_data\/\.db-staging(?:\/|$)/.test(path)) continue;
    const start = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
    calls.push({ operation, path, start, end: start + Number(duration) });
  }
}

const modes = calls.filter((call) => call.operation === "fchmod");
const syncs = calls.filter((call) => call.operation === "fsync");
if (!modes.length || !syncs.length) throw new Error("Missing actual seed mode/sync syscalls");
const firstSync = Math.min(...syncs.map((call) => call.start));
const lastMode = Math.max(...modes.map((call) => call.end));
const modePaths = new Set(modes.map((call) => call.path));
const syncPaths = new Set(syncs.map((call) => call.path));
if (modePaths.size !== syncPaths.size || [...modePaths].some((path) => !syncPaths.has(path)))
  throw new Error("Seed mode preparation and per-entry durability paths differ");
console.log(
  JSON.stringify({
    qualification: "Actual metadata syscall ordering; separate from startup budget acceptance.",
    modePaths: modePaths.size,
    syncedPaths: syncPaths.size,
    modesAfterFirstSync: modes.filter((call) => call.start >= firstSync).length,
    allModesPreparedBeforeFirstSync: lastMode <= firstSync,
  }),
);
if (lastMode > firstSync) throw new Error("Seed metadata changed after its durability barriers began");
