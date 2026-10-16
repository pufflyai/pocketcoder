import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { closeDbConnection, connectToNxDb, type HashedTask, NxCache, TaskDetails } from "nx/src/native/index";

type Entry = HashedTask & { terminalOutput?: string; size?: number };
type Manifest = { version: 1; entries: Entry[] };

async function readManifest(directory: string): Promise<Manifest> {
  const file = Bun.file(join(directory, "portable-v1.json"));
  return (await file.exists()) ? file.json() : { version: 1, entries: [] };
}

async function withCache(
  root: string,
  work: (cache: NxCache, details: TaskDetails, directory: string) => Promise<void>,
) {
  const directory = join(root, ".nx/cache");
  const data = join(root, ".nx/workspace-data");
  await mkdir(data, { recursive: true });
  const db = connectToNxDb(data);
  try {
    await work(new NxCache(root, directory, db), new TaskDetails(db), directory);
  } finally {
    closeDbConnection(db);
  }
}

export async function importTaskCache(root: string) {
  await withCache(root, async (cache, details, directory) => {
    const manifest = await readManifest(directory);
    if (manifest.version !== 1) throw new Error("Unsupported portable Nx cache version");
    for (const entry of manifest.entries) {
      details.recordTaskDetails([entry]);
      cache.applyRemoteCacheResults(entry.hash, { ...entry, code: 0, outputsPath: join(directory, entry.hash) });
    }
  });
}

export async function exportTaskCache(root: string) {
  await withCache(root, async (cache, _details, directory) => {
    const previous = await readManifest(directory);
    const runFile = Bun.file(join(directory, "run.json"));
    const run: { tasks: { hash: string; projectName: string; target: string; configuration?: string }[] } =
      (await runFile.exists()) ? await runFile.json() : { tasks: [] };
    const tasks = new Map(previous.entries.map((entry) => [entry.hash, entry]));
    for (const task of run.tasks) tasks.set(task.hash, { ...task, project: task.projectName });
    const entries: Entry[] = [];
    for (const task of tasks.values()) {
      const result = cache.get(task.hash);
      if (result?.code === 0) entries.push({ ...task, terminalOutput: result.terminalOutput, size: result.size });
    }
    await Bun.write(join(directory, "portable-v1.json"), `${JSON.stringify({ version: 1, entries })}\n`);
  });
}

if (import.meta.main) {
  if (process.argv[2] === "import") await importTaskCache(process.cwd());
  else if (process.argv[2] === "export") await exportTaskCache(process.cwd());
  else throw new Error("Use task-cache.ts import or export");
}
