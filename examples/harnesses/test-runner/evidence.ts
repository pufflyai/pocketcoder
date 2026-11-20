import { access, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RunRequest } from "./protocol";

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
export async function uploadResults(request: RunRequest, repo: string, archive: string, signal: AbortSignal) {
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
  try {
    signal.throwIfAborted();
    const tar = Bun.spawn(["tar", "-czf", archive, "-C", repo, ...args], { stderr: "pipe", signal });
    const [code, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
    if (code !== 0) throw new Error(`Results archive failed: ${stderr}`);
    if (Bun.file(archive).size > request.results.maxBytes) throw new Error("Results exceed maxBytes");
    return await uploadFile(request.results.url, archive, "application/gzip", signal);
  } finally {
    await rm(archive, { force: true });
  }
}
