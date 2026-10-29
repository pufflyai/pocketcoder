import { expect, test } from "bun:test";
import { desktopDisplayCommand, desktopIsManaged, desktopWindow, windowManagerIsReady } from "./desktop-readiness";

test("an X window alone does not make a desktop ready for input", () => {
  expect(desktopIsManaged("_NET_WM_DESKTOP:  not found.")).toBe(false);
  expect(desktopIsManaged("_NET_WM_DESKTOP(CARDINAL) = 0\n")).toBe(true);
});

test("the window manager must finish starting before the terminal opens", () => {
  expect(windowManagerIsReady("_NET_SUPPORTING_WM_CHECK: not found.")).toBe(false);
  expect(windowManagerIsReady("_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x40000e\n")).toBe(true);
});

test("window management is checked on the terminal client, not its window-manager frame", () => {
  expect(desktopWindow('0x200123 "PocketCoder desktop": ("xterm" "XTerm")  804x394+0+0')).toBe("0x200123");
  expect(desktopWindow("0x400009 (has no name): ()  806x419+60+60")).toBeUndefined();
});

test.skipIf(!Bun.which("Xvfb"))("readiness probes do not reset the display between X clients", async () => {
  const display = `:${1000 + (process.pid % 50000)}`;
  const server = Bun.spawn(desktopDisplayCommand(display), { stdout: "ignore", stderr: "ignore" });
  async function probe(args: string[]) {
    const child = Bun.spawn(["xprop", "-display", display, "-root", ...args], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    return { output, code: await child.exited };
  }
  try {
    const deadline = Date.now() + 2000;
    while ((await probe(["_NET_SUPPORTING_WM_CHECK"])).code !== 0) {
      if (server.exitCode !== null || Date.now() >= deadline) throw new Error("Xvfb did not start");
      await Bun.sleep(25);
    }
    expect((await probe(["-f", "_POCKETCODER_STARTUP", "8s", "-set", "_POCKETCODER_STARTUP", "ready"])).code).toBe(0);
    // Leave no X client connected, as happens between startup probes and Openbox.
    await Bun.sleep(100);
    expect((await probe(["_POCKETCODER_STARTUP"])).output).toContain('= "ready"');
  } finally {
    server.kill("SIGTERM");
    await server.exited;
  }
});
