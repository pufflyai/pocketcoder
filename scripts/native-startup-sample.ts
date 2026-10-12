import { readFile } from "node:fs/promises";

async function counters(path: string) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [name, ...values] = line.trim().split(/\s+/);
      return { name, values: values.map(Number) };
    });
}

async function pressure(resource: string) {
  return (await readFile(`/proc/pressure/${resource}`, "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [kind, ...values] = line.split(" ");
      return {
        kind,
        values: Object.fromEntries(
          values.map((value) => {
            const [key, count] = value.split("=");
            return [key, Number(count)];
          }),
        ),
      };
    });
}

async function processCounters(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command field may contain spaces. Discard it before selecting numeric counters.
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const children = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim();
    return {
      pid,
      ppid: Number(fields[1]),
      state: fields[0],
      userTicks: Number(fields[11]),
      systemTicks: Number(fields[12]),
      startTicks: Number(fields[19]),
      rssPages: Number(fields[21]),
      children: children ? children.split(/\s+/).map(Number) : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { pid, exitedDuringSample: true, children: [] };
  }
}

export async function startupSample(rootPid: number) {
  const epochMs = Date.now();
  const processes: Awaited<ReturnType<typeof processCounters>>[] = [];
  const pending = [rootPid];
  while (pending.length) {
    const pid = pending.pop();
    if (pid === undefined) break;
    const record = await processCounters(pid);
    processes.push(record);
    pending.push(...record.children);
  }
  const [cpu, disks, cpuPressure, ioPressure, memoryPressure] = await Promise.all([
    counters("/proc/stat"),
    readFile("/proc/diskstats", "utf8"),
    pressure("cpu"),
    pressure("io"),
    pressure("memory"),
  ]);
  return {
    epochMs,
    completedEpochMs: Date.now(),
    cpu,
    disks: disks
      .trim()
      .split("\n")
      .map((line) => {
        const [major, minor, device, ...values] = line.trim().split(/\s+/);
        return { major: Number(major), minor: Number(minor), device, values: values.map(Number) };
      }),
    pressure: { cpu: cpuPressure, io: ioPressure, memory: memoryPressure },
    processes,
  };
}
