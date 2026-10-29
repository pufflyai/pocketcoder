import { readFileSync, readlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export function nativeState(pid: number) {
  if (process.platform !== "linux") return "";
  try {
    return JSON.stringify({
      exe: readlinkSync(`/proc/${pid}/exe`),
      command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "),
      wait: readFileSync(`/proc/${pid}/wchan`, "utf8").trim(),
      state: readFileSync(`/proc/${pid}/status`, "utf8").match(/^State:.*$/m)?.[0],
      children: readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim(),
    });
  } catch (error) {
    // The kernel can release the PID before Bun publishes its exit status.
    return JSON.stringify({ inspectionError: String(error) });
  }
}

export async function browserPort(profile: string, child: Bun.Subprocess, executable: string) {
  const deadline = Date.now() + 5000;
  const status = () =>
    `executable=${executable}, pid=${child.pid}, exitCode=${child.exitCode}, signal=${child.signalCode}`;
  while (true) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Chromium exited before readiness: ${status()}`);
    const port = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
    if (port.length > 0) return port.split("\n")[0];
    if (Date.now() >= deadline)
      throw new Error(`Chromium did not become ready: ${status()}, native=${nativeState(child.pid)}`);
    await Bun.sleep(25);
  }
}
