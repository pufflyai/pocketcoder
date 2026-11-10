import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const MEDIA_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
};

// A stable ID per turn and file, so a replayed observation republishes the same object.
function publicationId(turnId: string, name: string) {
  const hash = createHash("sha256").update(`pi-publication/v1\0${turnId}\0${name}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    // Symlinks could point outside the turn's directory; only regular files are returned.
    else if (entry.isFile() && (await lstat(path)).isFile()) found.push(path);
  }
  return found.sort();
}

// Everything the turn saved in its output directory, frozen into the explicit publication the
// controller verifies and stores before it accepts the terminal fact. Over the limit, the
// publication is marked incomplete instead of silently dropping files.
export async function collectPublication(turnId: string, outputDir: string, maxBytes: number, complete: boolean) {
  const objects = [];
  let total = 0;
  let fits = true;
  for (const path of await files(outputDir)) {
    const bytes = await readFile(path);
    if (total + bytes.byteLength > maxBytes) {
      fits = false;
      break;
    }
    total += bytes.byteLength;
    const name = relative(outputDir, path);
    objects.push({
      publicationId: publicationId(turnId, name),
      name,
      mediaType: MEDIA_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream",
      sizeBytes: bytes.byteLength,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      contentBase64: bytes.toString("base64"),
    });
  }
  return { complete: complete && fits, objects };
}
