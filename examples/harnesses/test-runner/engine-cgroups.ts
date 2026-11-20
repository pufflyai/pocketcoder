import { mkdir, readFile, writeFile } from "node:fs/promises";

export async function prepareEngineCgroups() {
  const root = "/sys/fs/cgroup";
  await mkdir(`${root}/init`, { recursive: true });
  // Domain controllers need an empty parent. Keep the workspace init and engine
  // together so their descendants leave the root available for Docker's cgroups.
  for (const pid of new Set([1, process.pid])) await writeFile(`${root}/init/cgroup.procs`, String(pid));
  const controllers = (await readFile(`${root}/cgroup.controllers`, "utf8")).trim().split(/\s+/);
  await writeFile(`${root}/cgroup.subtree_control`, controllers.map((name) => `+${name}`).join(" "));
}
