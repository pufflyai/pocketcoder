import { mkdir, readFile, writeFile } from "node:fs/promises";

export async function prepareEngineCgroups() {
  const root = "/sys/fs/cgroup";
  await mkdir(`${root}/init`, { recursive: true });
  // Domain controllers need an empty parent. Children of the engine process
  // inherit /init, leaving the root available for Docker's container cgroups.
  await writeFile(`${root}/init/cgroup.procs`, String(process.pid));
  const controllers = (await readFile(`${root}/cgroup.controllers`, "utf8")).trim().split(/\s+/);
  await writeFile(`${root}/cgroup.subtree_control`, controllers.map((name) => `+${name}`).join(" "));
}
