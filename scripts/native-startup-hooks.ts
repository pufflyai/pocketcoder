import { readFile } from "node:fs/promises";
import type { BunPlugin } from "bun";

const helpers = `
async function startupPhase(phase, action) {
  const startMs = performance.now();
  const epochStartMs = Date.now();
  const cpu = process.cpuUsage();
  try { return await action(); }
  finally { console.error("[startup-phase] " + JSON.stringify({ phase, startMs, durationMs: performance.now() - startMs, epochStartMs, epochEndMs: Date.now(), cpuMicroseconds: process.cpuUsage(cpu), pid: process.pid })); }
}
function startupPhaseSync(phase, action) {
  const startMs = performance.now();
  const epochStartMs = Date.now();
  const cpu = process.cpuUsage();
  try { return action(); }
  finally { console.error("[startup-phase] " + JSON.stringify({ phase, startMs, durationMs: performance.now() - startMs, epochStartMs, epochEndMs: Date.now(), cpuMicroseconds: process.cpuUsage(cpu), pid: process.pid })); }
}
`;

type Hook = [string, string];
const hooks: Record<string, Hook[]> = {
  "packages/db/src/database/data-folder.ts": [
    [
      "const entries = seedEntries(directory);",
      'const entries = startupPhaseSync("seed-inventory", () => seedEntries(directory));',
    ],
    [
      "await seedPass(entries, prepareSeedEntry);",
      'await startupPhase("seed-private-modes", () => seedPass(entries, prepareSeedEntry));',
    ],
    [
      "await seedPass(entries, syncSeedEntry);",
      'await startupPhase("seed-durability-barriers", () => seedPass(entries, syncSeedEntry));',
    ],
  ],
  "packages/db/src/database/context.ts": [
    ["await loadCoreAssets()", 'await startupPhase("assets-total", () => loadCoreAssets())'],
    [
      "await new Bun.Archive(assets.seedArchive()).extract(stage)",
      'await startupPhase("seed-extract", async () => new Bun.Archive(assets.seedArchive()).extract(stage))',
    ],
    ["await syncSeed(stage)", 'await startupPhase("seed-sync", () => syncSeed(stage))'],
    [
      "await installDatabase(folder.dir, assets)",
      'await startupPhase("seed-install", () => installDatabase(folder.dir, assets))',
    ],
    ["client = databaseDir\n", 'client = await startupPhase("engine-open", async () => databaseDir\n'],
    [
      ": await PGlite.create({ ...options, loadDataDir: assets.memorySeed() });",
      ": await PGlite.create({ ...options, loadDataDir: assets.memorySeed() }));",
    ],
    ["await migrateDatabase(client)", 'await startupPhase("migrate", () => migrateDatabase(client))'],
    [
      "await bindCheckpointWriter(db, tables, folder)",
      'await startupPhase("checkpoint-writer", () => bindCheckpointWriter(db, tables, folder))',
    ],
    [
      "await bindJournal(db, tables, folder.dir, dataWriter, hooks.journalDir)",
      'await startupPhase("journal", () => bindJournal(db, tables, folder.dir, dataWriter, hooks.journalDir))',
    ],
  ],
  "packages/db/src/database/assets.ts": [
    [
      "const seedArchive = () => decodeDatabaseAsset(seed);",
      'const seedArchive = () => startupPhaseSync("seed-zstd", () => decodeDatabaseAsset(seed));',
    ],
    ["await loadDatabaseEngine()", 'await startupPhase("engine-assets", () => loadDatabaseEngine())'],
  ],
  "packages/db/src/database/engine-assets.ts": [
    [
      "return {\n      pgliteWasmModule:",
      'const unpacked = await startupPhase("engine-wasm-zstd", () => unpack(wasmPath, manifest.engine.wasm.checksum));\nreturn {\n      pgliteWasmModule:',
    ],
    [
      "await WebAssembly.compile(await unpack(wasmPath, manifest.engine.wasm.checksum))",
      'await startupPhase("engine-wasm-compile", () => WebAssembly.compile(unpacked))',
    ],
    [
      "await unpack(bundlePath, manifest.engine.data.checksum)",
      'await startupPhase("engine-data-zstd", () => unpack(bundlePath, manifest.engine.data.checksum))',
    ],
  ],
  "packages/db/src/store.ts": [
    [
      "return new PGliteStore(await createDatabaseContext(dataDir, options));",
      'const context = await startupPhase("database-context", () => createDatabaseContext(dataDir, options));\nreturn startupPhase("store-construction", () => new PGliteStore(context));',
    ],
  ],
  "packages/server/src/bootstrap/controller-store.ts": [
    ["await initializeKeys(directory)", 'await startupPhase("controller-keys", () => initializeKeys(directory))'],
  ],
  "packages/server/src/lifecycle/lifecycle.ts": [
    [
      "await initializeController(config, log)",
      'await startupPhase("initialize-controller", () => initializeController(config, log))',
    ],
    [
      "await store.recovery.recoveryState()",
      'await startupPhase("controller-recovery-state", () => store.recovery.recoveryState())',
    ],
    ["await accountState(directory)", 'await startupPhase("controller-account-state", () => accountState(directory))'],
  ],
};

// The hooks change only this diagnostic build. Missing hooks invalidate its evidence.
export function nativeStartupHooks(): BunPlugin {
  return {
    name: "native-startup-phase-diagnostics",
    setup(build) {
      build.onLoad({ filter: /\.(ts)$/ }, async ({ path }) => {
        const matched = Object.entries(hooks).find(([suffix]) => path.endsWith(`/${suffix}`));
        if (matched) {
          const [key, edits] = matched;
          let contents = await readFile(path, "utf8");
          for (const [before, after] of edits) {
            if (contents.split(before).length !== 2) throw new Error(`Diagnostic hook drift: ${key}`);
            contents = contents.replace(before, after);
          }
          return { contents: helpers + contents, loader: "ts" };
        }
        if (path.endsWith("/examples/native/controller.ts")) {
          const contents = await readFile(path, "utf8");
          const marker = 'pending = complete.pop() ?? "";';
          if (
            contents.split(marker).length !== 2 ||
            contents.split("const code = await processHandle.exited;").length !== 2 ||
            contents.split('const processHandle = Bun.spawn([executable, "serve"], {').length !== 2
          )
            throw new Error("Diagnostic controller hook drift");
          return {
            contents: contents
              .replace(
                marker,
                `${marker}\nfor (const line of complete) console.error("[startup-controller] " + JSON.stringify({ epochMs: Date.now(), line }));`,
              )
              .replace(
                "const code = await processHandle.exited;",
                'const code = await processHandle.exited;\nconsole.error("[startup-exit] " + JSON.stringify({ epochMs: Date.now(), pid: processHandle.pid, code, resourceUsage: processHandle.resourceUsage() }));',
              )
              .replace(
                'const processHandle = Bun.spawn([executable, "serve"], {',
                'console.error("[startup-spawn] " + JSON.stringify({ epochMs: Date.now(), startMs: performance.now(), pid: process.pid }));\nconst processHandle = Bun.spawn([executable, "serve"], {',
              ),
            loader: "ts",
          };
        }
      });
    },
  };
}
