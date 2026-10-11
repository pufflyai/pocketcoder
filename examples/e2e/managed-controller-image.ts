import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./local-process";

// This owned fixture uses the product recipe's flags and runtime without copying the repository into Docker cache.
const RECIPE = `FROM registry.k8s.io/kubectl:v1.34.1 AS kubectl
FROM oven/bun:1.4-slim
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
COPY server /opt/pocketcoder/server
COPY pcd /opt/pocketcoder/cli
COPY kubeconfig.yaml /opt/pocketcoder/kubeconfig.yaml
RUN chmod 0755 /opt/pocketcoder/cli/index.js \\
  && ln -s /opt/pocketcoder/cli/index.js /usr/local/bin/pcd
ENV POCKETCODER_DIR=/pc_data
ENV KUBECONFIG=/opt/pocketcoder/kubeconfig.yaml
WORKDIR /
CMD ["bun", "/opt/pocketcoder/server/index.js"]
`;

export async function buildManagedController(root: string, ownedDirectory: string, tag: string) {
  const context = join(ownedDirectory, "controller-build");
  await mkdir(context);
  const source = await sourceDigest(root);
  const builds = [
    ["packages/server/src/index.ts", "server"],
    ["packages/cli/src/index.ts", "pcd"],
  ];
  const bundles: Record<string, Record<string, string>> = {};
  for (const [entry, output] of builds) {
    await command(["bun", "build", entry as string, "--target", "bun", "--outdir", join(context, output as string)], {
      cwd: root,
      quiet: true,
    });
    bundles[output as string] = await bundleHashes(join(context, output as string));
  }
  await copyFile(join(root, "deploy/image/kubeconfig.yaml"), join(context, "kubeconfig.yaml"));
  await writeFile(join(context, "Dockerfile"), RECIPE);
  const metadataPath = join(ownedDirectory, "controller-build-metadata.json");
  await command(["docker", "build", "--metadata-file", metadataPath, "-t", tag, context], {
    quiet: true,
    env: { BUILDX_METADATA_PROVENANCE: "max" },
  });
  if ((await sourceDigest(root)).sha256 !== source.sha256) throw new Error("Fixture source changed during its build.");
  const image = JSON.parse((await command(["docker", "image", "inspect", tag], { quiet: true })).stdout)[0];
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const materials = metadata["buildx.build.provenance"]?.materials;
  if (!Array.isArray(materials) || !materials.some((material) => material.uri.includes("oven/bun")))
    throw new Error("Fixture build lacks its resolved runtime digest.");
  console.log(
    JSON.stringify({
      fixtureBuild: {
        qualification: "interim local host-bundled fixture; product Dockerfile unchanged",
        bundler: Bun.version,
        flags: "--target bun --outdir",
        source,
        bundles,
        recipe: RECIPE,
        recipeSha256: digest(RECIPE),
        kubeconfigSha256: digest(await readFile(join(context, "kubeconfig.yaml"))),
        runtime: { reference: "oven/bun:1.4-slim", materials },
        image: { tag, id: image.Id },
      },
    }),
  );
}

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

async function bundleHashes(directory: string) {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error("Fixture bundle contains an unexpected nonregular output.");
    hashes[entry.name] = digest(await readFile(join(directory, entry.name)));
  }
  if (!hashes["index.js"]) throw new Error("Fixture bundle entry is missing.");
  return hashes;
}

async function sourceDigest(root: string) {
  const listing = await command(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    quiet: true,
  });
  const paths = listing.stdout
    .split("\n")
    .filter((path) => path === "bun.lock" || /^packages\/[^/]+\/(src\/|assets\/|package.json$)/.test(path))
    .sort();
  const hashes = [];
  for (const path of paths) hashes.push(`${path} ${digest(await readFile(join(root, path)))}`);
  return { files: hashes.length, sha256: digest(hashes.join("\n")) };
}
