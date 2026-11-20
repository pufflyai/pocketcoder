import { mkdtemp, rm, writeFile } from "node:fs/promises";

// Each Kata VM owns one display. Its cookie and socket never reach another VM.
const directory = await mkdtemp(`${process.env.TMPDIR}/pocketcoder-x11-`);
const authority = `${directory}/authority`;
await writeFile(authority, "", { mode: 0o600 });
const env = { ...process.env, DISPLAY: ":99", XAUTHORITY: authority };
const cookie = crypto.randomUUID().replaceAll("-", "");
const authorize = Bun.spawn(["xauth", "-f", authority, "add", ":99", "MIT-MAGIC-COOKIE-1", cookie]);
if ((await authorize.exited) !== 0) throw new Error("Could not authorize the workspace display");
const server = Bun.spawn(["Xvfb", ":99", "-screen", "0", "1280x1024x24", "-nolisten", "tcp", "-auth", authority], {
  env,
  stdin: "ignore",
  stdout: "ignore",
  stderr: Bun.file("/workspace/xvfb.log"),
});
let manager: ReturnType<typeof Bun.spawn> | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
async function waitFor(command: string[], matches: (output: string) => boolean) {
  const deadline = Date.now() + 10_000;
  while (!stopping && Date.now() < deadline && server.exitCode === null) {
    const probe = Bun.spawn(command, { env, stdout: "pipe", stderr: "ignore" });
    const output = await new Response(probe.stdout).text();
    const exitCode = await probe.exited;
    if (stopping) throw new Error("The workspace display was canceled during startup");
    if (exitCode === 0 && matches(output)) return;
    await Bun.sleep(50);
  }
  throw new Error("The workspace display did not become ready");
}
try {
  await waitFor(["xdpyinfo"], () => true);
  manager = Bun.spawn(["openbox", "--sm-disable"], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: Bun.file("/workspace/display.log"),
  });
  await waitFor(["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"], (output) =>
    /window id # 0x[0-9a-f]*[1-9a-f]/i.test(output),
  );
  if (stopping) throw new Error("The workspace display was canceled during startup");
  child = Bun.spawn(process.argv.slice(2), { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
} finally {
  // Keep X11 alive until the supervisor has finished its own shutdown hooks.
  for (const process of [manager, server]) {
    if (process?.exitCode === null) process.kill("SIGTERM");
    await process?.exited;
  }
  await rm(directory, { recursive: true, force: true });
}
