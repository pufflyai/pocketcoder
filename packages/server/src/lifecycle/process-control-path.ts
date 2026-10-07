// Binds private control paths to the owning process and a local filesystem.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, statfs } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ServerConfig } from "../config/config";

export function processControlPath(root: string, instanceId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(instanceId))
    throw new Error("controller_instance_invalid");
  const directory = join(
    resolve(root),
    `control-${createHash("sha256").update(instanceId).digest("hex").slice(0, 16)}`,
  );
  return { directory, capabilityPath: join(directory, "control.json") };
}

function inside(path: string, root: string) {
  const tail = relative(resolve(root), path);
  return tail === "" || (tail !== ".." && !tail.startsWith(`..${sep}`) && !tail.startsWith(sep));
}

export async function privateDirectory(path: string) {
  const row = await lstat(path);
  if (
    !row.isDirectory() ||
    row.uid !== process.getuid?.() ||
    (row.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== resolve(path)
  ) {
    throw new Error("controller_control_root_unowned");
  }
  return row;
}

async function requireLocalFilesystem(root: string) {
  if (process.platform === "darwin") {
    // Darwin type numbers are dynamic. The system tool uses the kernel MNT_LOCAL flag.
    const result = spawnSync("/bin/df", ["-l", "-n", "-P", "-I", root], {
      env: { LC_ALL: "C" },
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 4096,
    });
    if (result.status !== 0 || result.stdout.trim().split("\n").length !== 2)
      throw new Error("controller_control_filesystem_unknown");
    return;
  }
  const type = (await statfs(root)).type;
  if (process.platform !== "linux" || ![0xef53, 0x01021994, 0x58465342, 0x9123683e, 0x794c7630].includes(type)) {
    throw new Error("controller_control_filesystem_unknown");
  }
}

async function currentCheckout() {
  let directory = process.cwd();
  while (true) {
    const git = await lstat(join(directory, ".git")).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (git) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function createControlDirectory(root: string, instanceId: string, config: ServerConfig) {
  root = resolve(root);
  for (const excluded of [
    await currentCheckout(),
    config.workspaceDataDir,
    config.checkpointDir,
    config.inputDir,
    config.secretRoot,
    config.templateDir,
  ]) {
    if (excluded && inside(root, excluded)) throw new Error("controller_control_root_exposed");
  }
  const parent = await privateDirectory(root);
  await requireLocalFilesystem(root);
  const paths = processControlPath(root, instanceId);
  await mkdir(paths.directory, { mode: 0o700 });
  const directory = await privateDirectory(paths.directory);
  const check = await privateDirectory(root);
  if (check.dev !== parent.dev || check.ino !== parent.ino) throw new Error("controller_control_root_changed");
  return { ...paths, directoryIdentity: directory };
}
