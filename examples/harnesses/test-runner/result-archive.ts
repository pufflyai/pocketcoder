import type { FileSink } from "bun";

// Bound compressed bytes while writing, before a snapshot can exhaust scratch storage.
export async function writeResultArchive(
  repo: string,
  args: string[],
  archive: string,
  maxBytes: number,
  signal: AbortSignal,
  snapshot: boolean,
) {
  signal.throwIfAborted();
  const child = Bun.spawn(["tar", "-czf", "-", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  const errors = (async () => {
    let tail = "";
    for await (const chunk of child.stderr) tail = (tail + new TextDecoder().decode(chunk)).slice(-8192);
    return tail;
  })();
  const sink: FileSink = Bun.file(archive).writer();
  let bytes = 0;
  try {
    signal.throwIfAborted();
    for await (const chunk of child.stdout) {
      signal.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error("Results exceed maxBytes");
      sink.write(chunk);
      await sink.flush();
    }
    const [code, stderr] = await Promise.all([child.exited, errors]);
    // GNU tar exit 1 means files changed during capture; such snapshots are explicitly partial.
    const changedFiles = stderr
      .trim()
      .split("\n")
      .every((line) => /^tar: .+: file changed as we read it$/.test(line));
    if (code !== 0 && !(snapshot && code === 1 && changedFiles)) throw new Error(`Results archive failed: ${stderr}`);
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    await Promise.allSettled([child.exited, errors, sink.end()]);
  }
}
