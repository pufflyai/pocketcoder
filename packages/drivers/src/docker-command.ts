export async function runDocker(bin: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`docker ${args[0]} failed (${code}): ${stderr.trim().slice(0, 500)}`);
  }
  return stdout.trim();
}

// Local builds have an immutable image ID but no registry manifest digest.
export async function resolveDockerImage(dockerBin: string, image: string): Promise<string> {
  const separator = image.lastIndexOf("@");
  if (separator === -1) return image;
  const digest = image.slice(separator + 1);
  try {
    const localId = await runDocker(dockerBin, ["image", "inspect", digest, "--format", "{{.Id}}"]);
    if (localId === digest) return digest;
  } catch {
    // Registry digests are not necessarily addressable as local image IDs.
  }
  return image;
}
