import { readFile } from "node:fs/promises";
import type { BunPlugin } from "bun";

const helpers = `
async function startupPhase(phase, action) {
  const startMs = performance.now();
  try { return await action(); }
  finally { console.error("[startup-phase] " + JSON.stringify({ phase, startMs, durationMs: performance.now() - startMs, pid: process.pid })); }
}
function startupPhaseSync(phase, action) {
  const startMs = performance.now();
  try { return action(); }
  finally { console.error("[startup-phase] " + JSON.stringify({ phase, startMs, durationMs: performance.now() - startMs, pid: process.pid })); }
}
`;

type Hook = [string, string];
const hooks: Record<string, Hook[]> = {
  "packages/db/src/database/context.ts": [
    ["await loadCoreAssets()", 'await startupPhase("assets-total", () => loadCoreAssets())'],
    [
      "await new Bun.Archive(await assets.loadDataDir.arrayBuffer()).extract(stage)",
      'await startupPhase("seed-extract", async () => new Bun.Archive(await assets.loadDataDir.arrayBuffer()).extract(stage))',
    ],
    ["await syncSeed(stage)", 'await startupPhase("seed-sync", () => syncSeed(stage))'],
    [
      "await installDatabase(folder.dir, assets)",
      'await startupPhase("seed-install", () => installDatabase(folder.dir, assets))',
    ],
    ["client = folder\n", 'client = await startupPhase("engine-open-with-install", async () => folder\n'],
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
      'const seed = Bun.gzipSync(await unpack(seedPath, manifest.checksum, "core seed"));',
      'const unpacked = await startupPhase("seed-brotli", () => unpack(seedPath, manifest.checksum, "core seed"));\nconst seed = startupPhaseSync("seed-gzip", () => Bun.gzipSync(unpacked));',
    ],
    ["await loadDatabaseEngine()", 'await startupPhase("engine-assets", () => loadDatabaseEngine())'],
  ],
  "packages/db/src/database/engine-assets.ts": [
    [
      "return {\n      pgliteWasmModule:",
      'const unpacked = await startupPhase("engine-wasm-brotli", () => unpack(wasmPath, manifest.engine.wasm.checksum));\nreturn {\n      pgliteWasmModule:',
    ],
    [
      "await WebAssembly.compile(await unpack(wasmPath, manifest.engine.wasm.checksum))",
      'await startupPhase("engine-wasm-compile", () => WebAssembly.compile(unpacked))',
    ],
    [
      "await unpack(bundlePath, manifest.engine.data.checksum)",
      'await startupPhase("engine-data-brotli", () => unpack(bundlePath, manifest.engine.data.checksum))',
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
          if (contents.split(marker).length !== 2) throw new Error("Diagnostic controller hook drift");
          return {
            contents: contents.replace(
              marker,
              `${marker}\nfor (const line of complete) if (line.startsWith("[startup-phase] ")) console.error(line);`,
            ),
            loader: "ts",
          };
        }
      });
    },
  };
}
