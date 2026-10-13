import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../../..");
async function command(args: string[]) {
  const child = Bun.spawn(args, { cwd: repository, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  if (await child.exited) throw new Error(error || `${args[0]} failed.`);
  return output.trim();
}

export async function buildOperatorBundle(directory: string) {
  await mkdir(directory, { recursive: true });
  const stage = await mkdtemp(join(tmpdir(), "pc103-operator-build-"));
  try {
    const commit = await command(["git", "rev-parse", "HEAD"]);
    const installed = join(stage, "installed");
    const result = await Bun.build({
      entrypoints: [
        join(repository, "packages/manager/src/index.ts"),
        join(repository, "deploy/recovery/run-account-backups.ts"),
        join(repository, "deploy/recovery/run-manager-backup.ts"),
        join(import.meta.dir, "run-access.ts"),
      ],
      outdir: installed,
      target: "bun",
      naming: "[name].[ext]",
    });
    if (!result.success) throw new AggregateError(result.logs, "Operator bundle build failed.");
    await Bun.write(join(installed, "release.json"), JSON.stringify({ commit, bun: Bun.version }));
    const files = (await readdir(installed)).sort();
    for (const file of files) {
      await chmod(join(installed, file), 0o644);
      await utimes(join(installed, file), 0, 0);
    }
    const archive = join(stage, "operator.tar");
    await command(["tar", "--format=ustar", "-cf", archive, "-C", stage, ...files.map((file) => `installed/${file}`)]);
    const path = join(resolve(directory), "operator.tar.gz");
    const compressed = Bun.spawn(["gzip", "-n", "-c", archive], { stdout: Bun.file(path), stderr: "pipe" });
    if (await compressed.exited) throw new Error("Operator archive compression failed.");
    const sha256 = createHash("sha256")
      .update(Buffer.from(await Bun.file(path).arrayBuffer()))
      .digest("hex");
    const release = { commit, sha256, path };
    await Bun.write(join(directory, "operator.json"), `${JSON.stringify(release, null, 2)}\n`);
    return release;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error("Usage: bundle.ts OUTPUT_DIRECTORY");
  if (await command(["git", "status", "--porcelain"])) throw new Error("Build a clean, committed checkout.");
  console.log(JSON.stringify(await buildOperatorBundle(resolve(directory))));
}
