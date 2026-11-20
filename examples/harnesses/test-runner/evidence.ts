import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { RunRequest } from "./protocol";
import { writeResultArchive } from "./result-archive";

export async function uploadFile(url: string, path: string, type: string, signal: AbortSignal) {
  const file = Bun.file(path);
  const bytes = file.size;
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": type },
    body: file,
    signal,
  });
  if (!response.ok) throw new Error(`Evidence upload failed with HTTP ${response.status}`);
  return { uploaded: true, bytes };
}
export async function uploadResults(
  request: Pick<RunRequest, "results">,
  repo: string,
  archive: string,
  signal: AbortSignal,
  snapshot = false,
  temporaryRoot?: string,
) {
  const paths: string[] = [];
  for (const path of request.results.paths) {
    signal.throwIfAborted();
    if (!path || isAbsolute(path) || path.split(/[\\/]/).some((p) => p === ".." || p === ".git"))
      throw new Error("Unsafe results path");
    if (
      await access(join(repo, path)).then(
        () => true,
        () => false,
      )
    )
      paths.push(path);
  }
  // An empty archive distinguishes a successful collection with no files from lost evidence.
  const args = paths.length ? paths : ["-T", "/dev/null"];
  if (temporaryRoot) {
    for (const pattern of request.results.temporaryPaths ?? []) {
      if (!pattern || isAbsolute(pattern) || pattern.split(/[\\/]/).some((p) => p === ".." || p === ".git"))
        throw new Error("Unsafe temporary results path");
      for await (const path of new Bun.Glob(pattern).scan({ cwd: temporaryRoot, onlyFiles: false })) {
        signal.throwIfAborted();
        args.push("-C", dirname(temporaryRoot), join(basename(temporaryRoot), path));
      }
    }
  }
  const metadata = `${archive}.metadata`;
  try {
    signal.throwIfAborted();
    if (snapshot) {
      await mkdir(metadata, { recursive: true });
      await writeFile(
        join(metadata, "evidence-snapshot.json"),
        JSON.stringify({ complete: false, capturedAt: new Date().toISOString() }),
      );
      args.push("-C", metadata, "evidence-snapshot.json");
    }
    await writeResultArchive(repo, args, archive, request.results.maxBytes, signal, snapshot);
    return await uploadFile(request.results.url, archive, "application/gzip", signal);
  } finally {
    await rm(archive, { force: true });
    await rm(metadata, { recursive: true, force: true });
  }
}
