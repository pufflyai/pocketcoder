import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";

// Run through engine.ts with POCKETCODER_VIRTUAL_DISPLAY=0 in the review image.
// The child owns the real display so the test can signal it without killing itself.
test("the private display waits for supervisor cleanup on TERM", async () => {
  const directory = await mkdtemp("/workspace/tmp/display-shutdown-");
  const ready = `${directory}/ready`;
  const complete = `${directory}/complete`;
  const fixture = `
    process.on("SIGTERM", async () => {
      console.log("TERM_RECEIVED");
      await Bun.sleep(750);
      await Bun.write(${JSON.stringify(complete)}, "complete");
      console.log("CLEANUP_COMPLETE");
      process.exit(0);
    });
    await Bun.write(${JSON.stringify(ready)}, "ready");
    setInterval(() => {}, 1000);
  `;
  const session = Bun.spawn(["bun", "/opt/pocketcoder/display-session.js", "bun", "-e", fixture], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(session.stdout).text();
  const stderr = new Response(session.stderr).text();
  try {
    const deadline = Date.now() + 25_000;
    while (!(await Bun.file(ready).exists()) && session.exitCode === null && Date.now() < deadline) await Bun.sleep(25);
    expect(await Bun.file(ready).exists()).toBe(true);
    session.kill("SIGTERM");
    expect(await session.exited).toBe(0);
    expect(await Bun.file(complete).text()).toBe("complete");
    expect(await stdout).toContain("CLEANUP_COMPLETE");
    expect(await stderr).toBe("");
  } finally {
    if (session.exitCode === null) session.kill("SIGKILL");
    await session.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
