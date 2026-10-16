import { readdirSync, readFileSync } from "node:fs";

export function groupHasWriters(groupId: number) {
  try {
    process.kill(-groupId, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Permission denial is not stop proof. macOS can return it during exit.
    if (code === "EPERM") return true;
    if (code !== "ESRCH") throw error;
    return false;
  }
  if (process.platform !== "linux") return true;
  return scanGroupWriters(groupId);
}

const linuxProc = {
  pids: () => readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)),
  stat: (pid: string) => readFileSync(`/proc/${pid}/stat`, "utf8"),
};

export function scanGroupWriters(groupId: number, proc = linuxProc) {
  // PID 1 can retain orphan zombies. They keep a group ID but cannot write.
  const before = proc.pids();
  for (const pid of before) {
    try {
      const stat = proc.stat(pid);
      const [state, _parent, group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(group) === groupId && state !== "Z" && state !== "X") return true;
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      return true;
    }
  }
  // A newly forked child may have missed the first inventory. Retry on churn.
  const after = new Set(proc.pids());
  return before.length !== after.size || before.some((pid) => !after.has(pid));
}
