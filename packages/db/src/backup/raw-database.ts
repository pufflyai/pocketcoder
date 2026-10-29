import { PGlite } from "@electric-sql/pglite";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import { loadCoreAssets } from "../database/assets";
import { boundedFilesystem, type DatabaseBudget } from "./bounded-filesystem";

// Opens a copied database folder without migrations, data-folder locks or writer checks.
export async function openRawDatabase(directory: string, budget?: DatabaseBudget) {
  const assets = await loadCoreAssets();
  return PGlite.create({
    pgliteWasmModule: assets.pgliteWasmModule,
    fsBundle: assets.fsBundle,
    fs: boundedFilesystem(new NodeFS(directory), directory, budget),
  });
}
