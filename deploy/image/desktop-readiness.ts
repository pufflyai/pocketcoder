export function desktopIsManaged(properties: string) {
  return /^_NET_WM_DESKTOP\(CARDINAL\) = 0$/m.test(properties.trim());
}

export function desktopWindow(tree: string) {
  return tree.match(/(0x[0-9a-f]+) "PocketCoder desktop": \("xterm" "XTerm"\)/)?.[1];
}

export function windowManagerIsReady(properties: string) {
  return /_NET_SUPPORTING_WM_CHECK\(WINDOW\): window id # 0x[1-9a-f][0-9a-f]*/.test(properties);
}
