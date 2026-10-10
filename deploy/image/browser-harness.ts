const command = process.argv.slice(2);
if (!command.length) throw new Error("A template-owned agent command is required.");
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;
const spawn = (args: string[]) => {
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  children.push(child);
  return child;
};
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
  // The non-root workspace container supplies the isolation boundary and bounded /tmp.
  const browser = spawn([
    "chromium",
    "--headless",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--no-first-run",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9222",
    "--user-data-dir=/tmp/pocketcoder-browser",
    "--window-size=1280,800",
    "about:blank",
  ]);
  const deadline = Date.now() + 10_000;
  while (true) {
    const ready = await fetch("http://127.0.0.1:9222/json/list", { signal: AbortSignal.timeout(500) })
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) break;
    if (browser.exitCode !== null || stopping || Date.now() >= deadline) throw new Error("Chromium did not start.");
    await Bun.sleep(25);
  }
  spawn(command);
  await Promise.race(children.map((child) => child.exited));
} finally {
  await stop();
}
