import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTemplateCapacity } from "./instance-inputs";
import { parseCatalogTemplate } from "./template-catalog";

export async function snapshotTemplateImport(source: string, capacity: Record<string, number> | undefined) {
  const entries = (await readdir(source, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && /\.(json|ya?ml)$/.test(entry.name),
  );
  const files = await Promise.all(
    entries.map(async ({ name }) => ({ name, text: await readFile(join(source, name), "utf8") })),
  );
  for (const file of files) requireTemplateCapacity(parseCatalogTemplate(file.name, file.text).manifest, capacity);
  // The CLI validates full manifests. Give it the same bytes whose capacity we checked,
  // so a catalog edit cannot bypass the check between the two reads.
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-template-import-"));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    for (const file of files) await writeFile(join(directory, file.name), file.text, { mode: 0o600 });
    return { directory, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
