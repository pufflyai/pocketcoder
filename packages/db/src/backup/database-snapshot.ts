import { closeSync, constants, lstatSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseContext } from "../database/context";
import type { ArchiveOutput } from "./archive-output";
import { fileChunks } from "./file-chunks";
import { openPublishedArchive, type PublishedArchive } from "./published-archive";
import { type Publication, readSnapshotState } from "./snapshot-queries";

// Process-local files that pg_basebackup also leaves out; the engine recreates them.
const SKIPPED = new Set(["postmaster.pid", "postmaster.opts", "pg_internal.init"]);

async function copyTree(archive: ArchiveOutput, root: string, path: string, check: () => void) {
  await archive.directory(path);
  const names = readdirSync(join(root, path)).sort();
  for (const name of names) {
    const member = `${path}/${name}`;
    const stat = lstatSync(join(root, member));
    if (stat.isDirectory()) await copyTree(archive, root, member, check);
    else if (!stat.isFile()) throw new Error(`Database folder has an unsupported entry: ${member}`);
    else if (!SKIPPED.has(name)) {
      const file = openSync(join(root, member), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await archive.file(member, stat.size, fileChunks(file, stat.size, check));
      } finally {
        closeSync(file);
      }
    }
  }
}

// Copies the database while no query or transaction can run, and opens every checkpoint
// archive that snapshot references. The caller copies those archives after it lets writes resume.
export async function captureDatabase(
  context: DatabaseContext,
  archive: ArchiveOutput,
  checkpointDirectory: string | undefined,
  check: () => void,
  requireSettledProviders = false,
) {
  const dataDir = context.dataDir;
  if (!dataDir) throw new Error("Backup requires a data folder on disk.");
  const client = context.client;
  return client._runExclusiveTransaction(() =>
    client.runExclusive(async () => {
      check();
      context.validateStorage?.();
      const state = await readSnapshotState(client, context.schema, requireSettledProviders);
      // Journal records are written before their database change, so this head covers the snapshot.
      const journal = context.journal?.head();
      if (!journal) throw new Error("Backup requires the deletion journal.");
      if (state.publications.length && !checkpointDirectory)
        throw new Error("Backup needs the checkpoint directory that holds referenced archives.");
      const opened: (Publication & { file: PublishedArchive })[] = [];
      try {
        for (const publication of state.publications)
          opened.push({
            ...publication,
            file: openPublishedArchive(checkpointDirectory as string, publication.name, publication.identity),
          });
        await copyTree(archive, dataDir, "db", check);
        return { position: state.position, migrations: state.migrations, journal, publications: opened };
      } catch (error) {
        for (const publication of opened) publication.file.close();
        throw error;
      }
    }),
  );
}
