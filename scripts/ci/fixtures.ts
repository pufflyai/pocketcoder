import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CiImage } from "../../examples/local/ci-images";
import { command } from "./command";

const recipes = {
  workspace: { context: "deploy/image", dockerfile: "deploy/image/Dockerfile" },
  server: { context: ".", dockerfile: "deploy/image/server.Dockerfile" },
  pi: { context: ".", dockerfile: "examples/harnesses/pi/Dockerfile" },
  oss: { context: ".", dockerfile: "examples/harnesses/oss/Dockerfile" },
};

async function fileHash(path: string) {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

const [action, directory, role] = process.argv.slice(2);
if (!directory) throw new Error("Fixture artifacts require an output directory");
const commit = (await command(["git", "rev-parse", "HEAD"], true)).trim();
if (commit !== process.env.GITHUB_SHA) throw new Error("Fixture checkout differs from the validation revision");
if (action === "build") {
  const recipe = recipes[role as keyof typeof recipes];
  if (!recipe) throw new Error("Unknown fixture role");
  await mkdir(directory, { recursive: true });
  const tag = `pocketcoder-ci-${role}:${commit}`;
  if (role === "workspace") {
    await command([
      "bun",
      "build",
      "packages/supervisor/src/index.ts",
      "--target",
      "bun",
      "--outdir",
      "deploy/image/dist",
    ]);
  }
  await command([
    "docker",
    "build",
    "--file",
    recipe.dockerfile,
    "--tag",
    tag,
    "--label",
    `org.opencontainers.image.revision=${commit}`,
    recipe.context,
  ]);
  const imageId = (await command(["docker", "image", "inspect", tag, "--format", "{{.Id}}"], true)).trim();
  const archive = `${role}.tar`;
  await command(["docker", "save", "--output", join(directory, archive), tag]);
  const record = { ...recipe, commit, tag, imageId, archive, sha256: await fileHash(join(directory, archive)) };
  await Bun.write(join(directory, `${role}.json`), `${JSON.stringify(record)}\n`);
} else if (action === "load") {
  const records: CiImage[] = [];
  for await (const path of new Bun.Glob("*.json").scan(directory)) {
    const record = await Bun.file(join(directory, path)).json();
    if (record.commit !== commit) throw new Error("Fixture artifact source revision differs");
    if ((await fileHash(join(directory, record.archive))) !== record.sha256)
      throw new Error("Fixture archive digest differs");
    await command(["docker", "load", "--input", join(directory, record.archive)]);
    const id = (await command(["docker", "image", "inspect", record.tag, "--format", "{{.Id}}"], true)).trim();
    if (id !== record.imageId) throw new Error("Loaded fixture image ID differs");
    records.push(record);
  }
  if (!records.length) throw new Error("No fixture artifacts were downloaded");
  await Bun.write(join(directory, "manifest"), `${JSON.stringify(records)}\n`);
} else throw new Error("Use fixtures.ts build or load");
