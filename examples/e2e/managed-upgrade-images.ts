import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManagerConfig } from "@pstdio/pocketcoder-manager";
import { controllerRelease } from "@pstdio/pocketcoder-server/release";
import type { BunPlugin } from "bun";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { type createKubernetesCluster, ROOT } from "./kubernetes-cluster";

type Cluster = Awaited<ReturnType<typeof createKubernetesCluster>>;
type Release = NonNullable<ManagerConfig["releases"]>[number];

async function buildUpgradeBundles(directory: string, plugin: BunPlugin) {
  for (const [entry, output] of [
    ["packages/server/src/index.ts", "server"],
    ["packages/cli/src/index.ts", "cli"],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [join(ROOT, entry)],
      target: "bun",
      outdir: join(directory, output),
      plugins: [plugin],
    });
    if (!result.success) throw new AggregateError(result.logs, "Upgrade fixture bundle failed.");
  }
}

export async function upgradeImages(cluster: Cluster, source: { tag: string; image: string }) {
  const directory = join(cluster.directory, "upgrades");
  await mkdir(directory);
  await symlink(join(ROOT, "node_modules"), join(directory, "node_modules"));
  const schema = join(directory, "schema.ts");
  await writeFile(
    schema,
    "import { pgTable, text } from 'drizzle-orm/pg-core';export const probe=pgTable('upgrade_demo_probe',{id:text().primaryKey()});\n",
  );
  const migrationsFolder = join(directory, "migrations");
  await cluster.run([
    "bun",
    join(ROOT, "packages/manager/node_modules/drizzle-kit/bin.cjs"),
    "generate",
    "--dialect",
    "postgresql",
    "--schema",
    schema,
    "--out",
    migrationsFolder,
  ]);
  const generated = readMigrationFiles({ migrationsFolder });
  const existing = await Bun.file(join(ROOT, "packages/db/assets/migrations.json")).json();
  const migrations = [...existing, ...generated];
  const seed = await Bun.file(join(ROOT, "packages/db/assets/core-seed.json")).json();
  const targetSeed = { ...seed, migrations: migrations.map(({ name, hash }) => ({ name, hash })) };
  const plugin: BunPlugin = {
    name: "owned-generated-upgrade-schema",
    setup(build) {
      build.onLoad({ filter: /packages\/db\/assets\/(migrations|core-seed)\.json$/ }, ({ path }) => ({
        contents: JSON.stringify(path.endsWith("migrations.json") ? migrations : targetSeed),
        loader: "json",
      }));
    },
  };
  const evidence =
    "https://github.com/pufflyai/pocketcoder/blob/feature/pc-92-managed-account-upgrades/docs/managed-account-upgrades.md";
  const first: Release = {
    ...controllerRelease,
    version: "1.0.0-rc.1",
    controllerImage: source.image,
    upgradesFrom: [],
    rollbackTo: [],
    evidence,
  };
  const releases = [first];
  const tags: string[] = [];
  const changedBundles = join(directory, "changed");
  await buildUpgradeBundles(changedBundles, plugin);
  const prepared = [];
  for (const [name, version, fault, changed] of [
    ["compatible", "1.0.0-rc.2", "write", false],
    ["migration", "1.0.0-rc.3", "migration", true],
    ["forward", "1.0.0-rc.4", "none", true],
    ["write", "1.0.0-rc.5", "write", true],
  ] as const) {
    const context = join(directory, name);
    await mkdir(context);
    const plugins = changed ? [plugin] : [];
    if (changed)
      for (const output of ["server", "cli"])
        await cp(join(changedBundles, output), join(context, output), { recursive: true });
    const entry = join(directory, `${name}.ts`);
    await writeFile(entry, faultEntry(name, fault));
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      outdir: join(context, "probe"),
      plugins,
      external: ["/opt/pocketcoder/server/index.js"],
    });
    if (!result.success) throw new AggregateError(result.logs, "Upgrade fixture probe failed.");
    const tag = `pocketcoder-upgrade:${cluster.name}-${name}`;
    tags.push(tag);
    await writeFile(
      join(context, "Dockerfile"),
      `FROM ${source.tag}\n${changed ? "COPY server /opt/pocketcoder/server\nCOPY cli /opt/pocketcoder/cli\n" : ""}COPY probe /opt/pocketcoder/probe\nCMD ["bun","/opt/pocketcoder/probe/${name}.js"]\n`,
    );
    await cluster.run(["docker", "build", "-t", tag, context]);
    prepared.push({ name, version, changed, tag });
  }
  // Export shared layers once, then import the complete fixture set into each node.
  await cluster.run(["kind", "load", "docker-image", "--name", cluster.name, ...tags]);
  for (const { name, version, changed, tag } of prepared) {
    const image = await imageReference(cluster, tag);
    releases.push({
      ...first,
      version,
      controllerImage: image,
      data: changed ? { ...first.data, migrations: targetSeed.migrations } : first.data,
      upgradesFrom: name === "forward" ? ["1.0.0-rc.3"] : [first.version],
      rollbackTo: changed ? [] : [first.version],
    });
  }
  console.log(
    JSON.stringify({
      upgradeFixtures: { generatedMigration: generated.map(({ name, hash }) => ({ name, hash })), releases },
    }),
  );
  return {
    releases,
    close: async () => {
      for (const tag of tags) await cluster.run(["docker", "image", "rm", tag]);
    },
  };
}

async function imageReference(cluster: Cluster, tag: string) {
  const reference = `docker.io/library/${tag}`;
  const listing = await cluster.run([
    "docker",
    "exec",
    cluster.nodes[0] as string,
    "ctr",
    "--namespace",
    "k8s.io",
    "images",
    "ls",
  ]);
  const digest = listing
    .split("\n")
    .find((line) => line.startsWith(`${reference} `))
    ?.split(/\s+/)[2];
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Upgrade fixture digest is missing.");
  const image = `${reference.split(":")[0]}@${digest}`;
  for (const node of cluster.nodes)
    await cluster.run(["docker", "exec", node, "ctr", "--namespace", "k8s.io", "images", "tag", reference, image]);
  return image;
}

function faultEntry(name: string, fault: string) {
  return `import { PGliteStore } from '@pstdio/pocketcoder-db';
import { loadOffNodeConfig, writePrivateJson } from '@pstdio/pocketcoder-db/off-node';
const fault=${JSON.stringify(fault)};
if(fault!=='none') {
  const directory=process.env.POCKETCODER_DIR!;
  const off=await loadOffNodeConfig(process.env.POCKETCODER_OFF_NODE_CONFIG!,directory);
  const store=await PGliteStore.create(directory,{acknowledgeJournal:off.journal.acknowledge});
  try {
    if(fault==='write') {
      await store.createPrincipal('upgrade-first-write',[],[]);
      const revoke=await Bun.file('/private/upgrade-demo-revoke.json').json().catch(()=>null);
      if(revoke)await store.revokeMachineKey(revoke.keyId,new Date());
    }
  } finally { await store.close(); }
  await writePrivateJson('/private/upgrade-demo-fault.json',{name:${JSON.stringify(name)},fault});
  for(;;)await Bun.sleep(1000);
}
const server=await import('/opt/pocketcoder/server/index.js');await server.runPocketCoderServerUntilSignal();\n`;
}
