export function desktopIsManaged(properties: string) {
  return /^_NET_WM_DESKTOP\(CARDINAL\) = 0$/m.test(properties.trim());
}

export function desktopWindow(tree: string) {
  return tree.match(/(0x[0-9a-f]+) "PocketCoder desktop": \("xterm" "XTerm"\)/)?.[1];
}

export function windowManagerIsReady(properties: string) {
  return /_NET_SUPPORTING_WM_CHECK\(WINDOW\): window id # 0x[1-9a-f][0-9a-f]*/.test(properties);
}

// Startup probes briefly leave no X client attached. Keep that gap from resetting the display.
export function desktopDisplayCommand(display = ":99") {
  return ["Xvfb", display, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac", "-noreset"];
}
