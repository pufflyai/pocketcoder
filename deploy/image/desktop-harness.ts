import { existsSync } from "node:fs";
import { desktopIsManaged, desktopWindow, windowManagerIsReady } from "./desktop-readiness";

const command = process.argv.slice(2);
if (!command.length) throw new Error("A template-owned agent command is required.");
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;
const spawn = (args: string[]) => {
  const child = Bun.spawn(args, { env: { ...process.env, DISPLAY: ":99" }, stdout: "inherit", stderr: "inherit" });
  children.push(child);
  return child;
};
async function probe(args: string[]) {
  const child = Bun.spawn(args, {
    env: { ...process.env, DISPLAY: ":99" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text;
}
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  await Promise.race([Promise.all(children.map((child) => child.exited)), Bun.sleep(1000)]);
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(children.map((child) => child.exited));
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
  const x = spawn(["Xvfb", ":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"]);
  const deadline = Date.now() + 10_000;
  while (!existsSync("/tmp/.X11-unix/X99")) {
    if (x.exitCode !== null || stopping || Date.now() >= deadline) throw new Error("Desktop display did not start.");
    await Bun.sleep(25);
  }
  spawn(["openbox"]);
  while (!windowManagerIsReady(await probe(["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"]))) {
    if (stopping || Date.now() >= deadline) throw new Error("Desktop window manager did not start.");
    await Bun.sleep(25);
  }
  spawn([
    "x11vnc",
    "-display",
    ":99",
    "-localhost",
    "-rfbport",
    "5900",
    "-nopw",
    "-forever",
    "-shared",
    "-noxdamage",
    "-nosel",
    "-noclipboard",
  ]);
  spawn(["xterm", "-title", "PocketCoder desktop", "-geometry", "100x30+60+60"]);
  while (true) {
    // Openbox's frame can have the same title. Input readiness belongs to the client window.
    const window = desktopWindow(await probe(["xwininfo", "-root", "-tree"]));
    if (window && desktopIsManaged(await probe(["xprop", "-id", window, "_NET_WM_DESKTOP"]))) break;
    if (stopping || Date.now() >= deadline) throw new Error("Desktop terminal did not become visible.");
    await Bun.sleep(25);
  }
  const background = spawn(["xsetroot", "-solid", "#24364b"]);
  if ((await background.exited) !== 0) throw new Error("Desktop background did not initialize.");
  children.splice(children.indexOf(background), 1);
  spawn(command);
  await Promise.race(children.map((child) => child.exited));
} finally {
  await stop();
}
