import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { checkPackedPackages, packPackage } from "./check-sdk-package";

const root = resolve(import.meta.dir, "..");
const packages = ["cli", "sdk", "remote"];

async function packCandidates(directory: string, commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("A full source commit is required");
  await mkdir(directory, { recursive: true });
  const records = [];
  for (const name of packages) {
    const source = join(root, "packages", name);
    const manifest = await Bun.file(join(source, "package.json")).json();
    const tarball = await packPackage(source, directory, name);
    const bytes = await Bun.file(tarball).arrayBuffer();
    records.push({
      name: manifest.name as string,
      version: manifest.version as string,
      file: basename(tarball),
      bytes: bytes.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    });
  }
  await Bun.write(
    join(directory, "packages.json"),
    `${JSON.stringify({ commit, channel: "candidate", packages: records }, null, 2)}\n`,
  );
}

export async function verifyCandidatePackages(directory: string, commit: string) {
  const record = (await Bun.file(join(directory, "packages.json")).json()) as {
    commit: string;
    channel: string;
    packages: { name: string; version: string; file: string; bytes: number; sha256: string }[];
  };
  if (!/^[a-f0-9]{40}$/.test(commit) || record.commit !== commit || record.channel !== "candidate")
    throw new Error("Candidate package commit or channel differs");
  const tarballs: Record<string, string> = {};
  for (const entry of record.packages) {
    const tarball = join(directory, entry.file);
    const bytes = await Bun.file(tarball).arrayBuffer();
    if (bytes.byteLength !== entry.bytes || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new Error(`Package checksum differs: ${entry.name}`);
    const unpack = Bun.spawn(["tar", "-xOf", tarball, "package/package.json"], { stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([
      unpack.exited,
      new Response(unpack.stdout).text(),
      new Response(unpack.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Package manifest could not be read: ${error}`);
    const manifest = JSON.parse(output);
    if (manifest.name !== entry.name || manifest.version !== entry.version) throw new Error("Package version differs");
    tarballs[entry.name] = tarball;
  }
  for (const name of packages) {
    if (!tarballs[`@pstdio/pocketcoder-${name}`]) throw new Error(`Candidate package missing: ${name}`);
  }
  return { record, tarballs };
}

if (import.meta.main) {
  const [action, directory, commit] = process.argv.slice(2);
  if (!directory || !commit || (action !== "pack" && action !== "check"))
    throw new Error("Usage: candidate-packages.ts <pack|check> <directory> <commit>");
  if (action === "pack") await packCandidates(resolve(directory), commit);
  else {
    const { record, tarballs } = await verifyCandidatePackages(resolve(directory), commit);
    await checkPackedPackages(tarballs);
    console.log(
      JSON.stringify({ result: "passed", platform: process.platform, arch: process.arch, ...record }, null, 2),
    );
  }
}
