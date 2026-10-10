import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function browserPort(profile: string, child: Bun.Subprocess, executable: string) {
  const deadline = Date.now() + 5000;
  const status = () =>
    `executable=${executable}, pid=${child.pid}, exitCode=${child.exitCode}, signal=${child.signalCode}`;
  while (true) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Chromium exited before readiness: ${status()}`);
    const port = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
    if (port.length > 0) return port.split("\n")[0];
    if (Date.now() >= deadline) throw new Error(`Chromium did not become ready: ${status()}`);
    await Bun.sleep(25);
  }
}
