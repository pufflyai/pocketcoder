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
  tasks: (pid: string) => readdirSync(`/proc/${pid}/task`),
  taskStat: (pid: string, tid: string) => readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf8"),
};

export function scanGroupWriters(groupId: number, proc = linuxProc) {
  // PID 1 can retain orphan zombies. They keep a group ID but cannot write.
  const before = proc.pids();
  for (const pid of before) {
    try {
      const stat = proc.stat(pid);
      const [state, _parent, group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(group) !== groupId) continue;
      if (state !== "Z" && state !== "X") return true;
      // A main thread can exit while its workers still write.
      const tasks = proc.tasks(pid);
      for (const tid of tasks) {
        const task = proc.taskStat(pid, tid);
        const state = task.slice(task.lastIndexOf(")") + 2).split(" ")[0];
        if (state !== "Z" && state !== "X") return true;
      }
      if (inventoryChanged(tasks, proc.tasks(pid))) return true;
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      return true;
    }
  }
  // A newly forked child may have missed the first inventory. Retry on churn.
  return inventoryChanged(before, proc.pids());
}

function inventoryChanged(before: string[], after: string[]) {
  const ids = new Set(after);
  return before.length !== ids.size || before.some((id) => !ids.has(id));
}
