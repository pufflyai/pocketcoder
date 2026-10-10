import { expect, test } from "bun:test";
import { desktopIsManaged, desktopWindow, windowManagerIsReady } from "./desktop-readiness";

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
