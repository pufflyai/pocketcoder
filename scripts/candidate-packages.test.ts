import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCandidatePackages } from "./candidate-packages";
import { packPackage } from "./check-sdk-package";

test("downloaded packages reject a different commit and changed tarballs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-candidate-record-"));
  const commit = "a".repeat(40);
  try {
    const packages = [];
    for (const suffix of ["cli", "sdk", "remote"]) {
      const file = `${suffix}.tgz`;
      const source = join(directory, suffix);
      await Bun.write(
        join(source, "package.json"),
        JSON.stringify({ name: `@pstdio/pocketcoder-${suffix}`, version: "1.0.0-next.1" }),
      );
      const tarball = await packPackage(source, directory, suffix);
      const bytes = Buffer.from(await Bun.file(tarball).arrayBuffer());
      await Bun.write(join(directory, file), bytes);
      packages.push({
        name: `@pstdio/pocketcoder-${suffix}`,
        version: "1.0.0-next.1",
        file,
        bytes: bytes.length,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      });
    }
    await Bun.write(join(directory, "packages.json"), JSON.stringify({ commit, channel: "candidate", packages }));
    expect(Object.keys((await verifyCandidatePackages(directory, commit)).tarballs)).toHaveLength(3);
    await expect(verifyCandidatePackages(directory, "b".repeat(40))).rejects.toThrow("commit");
    await Bun.write(
      join(directory, "packages.json"),
      JSON.stringify({
        commit,
        channel: "candidate",
        packages: packages.map((entry) => ({ ...entry, version: "9.9.9" })),
      }),
    );
    await expect(verifyCandidatePackages(directory, commit)).rejects.toThrow("version");
    await Bun.write(join(directory, "packages.json"), JSON.stringify({ commit, channel: "candidate", packages }));
    await Bun.write(join(directory, "cli.tgz"), "changed tarball bytes");
    await expect(verifyCandidatePackages(directory, commit)).rejects.toThrow("checksum");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
