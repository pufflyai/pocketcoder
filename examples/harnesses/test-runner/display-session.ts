// The review worker owns a private X server. Start its window manager before
// the supervisor so both source and packaged desktop checks see a ready display.
const manager = Bun.spawn(["openbox", "--sm-disable"], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: Bun.file("/workspace/display.log"),
});
let child: ReturnType<typeof Bun.spawn> | undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child?.kill(signal));
try {
  let ready = false;
  const deadline = Date.now() + 10_000;
  while (!ready && Date.now() < deadline && manager.exitCode === null) {
    const probe = Bun.spawn(["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(probe.stdout).text();
    ready = (await probe.exited) === 0 && /window id # 0x[0-9a-f]*[1-9a-f]/i.test(output);
    if (!ready) await Bun.sleep(50);
  }
  if (!ready) throw new Error("The workspace window manager did not become ready");
  child = Bun.spawn(process.argv.slice(2), { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  process.exitCode = await child.exited;
} finally {
  if (manager.exitCode === null) manager.kill("SIGTERM");
  await manager.exited;
}
