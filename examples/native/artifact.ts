import { chmod } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

export async function nativeRecord(binary: string, commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("A full source commit is required");
  const bytes = await Bun.file(binary).arrayBuffer();
  if (bytes.byteLength > 90_000_000) throw new Error("Executable exceeded 90 MB");
  const cli = await Bun.file(join(root, "packages/cli/package.json")).json();
  const seed = await Bun.file(join(root, "packages/db/assets/core-seed.json")).json();
  return {
    commit,
    platform: process.platform,
    arch: process.arch,
    version: cli.version as string,
    bytes: bytes.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    database: {
      app: seed.app as string,
      pglite: seed.pgliteVersion as string,
      postgres: seed.postgresVersion as string,
      seedSha256: seed.checksum as string,
      engine: seed.engine as {
        wasm: { checksum: string; sourceChecksum: string };
        data: { checksum: string; sourceChecksum: string };
      },
      migrations: seed.migrations as { name: string; hash: string }[],
    },
  };
}

export async function verifyNativeArtifact(directory: string, commit: string) {
  const record = (await Bun.file(join(directory, "native.json")).json()) as Awaited<ReturnType<typeof nativeRecord>>;
  if (!/^[a-f0-9]{40}$/.test(commit) || record.commit !== commit) throw new Error("Artifact commit differs");
  if (record.platform !== process.platform || record.arch !== process.arch)
    throw new Error("Artifact platform differs");
  const binary = join(directory, "pocketcoder");
  const bytes = await Bun.file(binary).arrayBuffer();
  if (
    bytes.byteLength !== record.bytes ||
    bytes.byteLength > 90_000_000 ||
    new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== record.sha256
  ) {
    throw new Error("Artifact checksum or size differs");
  }
  await chmod(binary, 0o755);
  return record;
}

if (import.meta.main) {
  const [binary, commit, output] = process.argv.slice(2);
  if (!binary || !commit || !output) throw new Error("Usage: artifact.ts <binary> <commit> <record.json>");
  await Bun.write(output, `${JSON.stringify(await nativeRecord(binary, commit), null, 2)}\n`);
}
