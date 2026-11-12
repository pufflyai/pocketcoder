import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTemplateCapacity } from "./instance-inputs";
import { parseCatalogTemplate } from "./template-catalog";

export async function snapshotTemplateDirectory(source: string) {
  const entries = (await readdir(source, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && /\.(json|ya?ml)$/.test(entry.name),
  );
  const files = await Promise.all(
    entries.map(async ({ name }) => ({ name, text: await readFile(join(source, name), "utf8") })),
  );
  const manifests = files.map((file) => parseCatalogTemplate(file.name, file.text).manifest);
  // The CLI validates full manifests. Give it the same bytes whose capacity we checked,
  // so sizing and publication use the same files even if the source changes.
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-template-import-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    for (const file of files) await writeFile(join(directory, file.name), file.text, { mode: 0o600 });
    return { directory, manifests, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function snapshotTemplateImport(source: string, capacity: Record<string, number> | undefined) {
  const snapshot = await snapshotTemplateDirectory(source);
  try {
    for (const manifest of snapshot.manifests) requireTemplateCapacity(manifest, capacity);
    return snapshot;
  } catch (error) {
    await snapshot.dispose();
    throw error;
  }
}
