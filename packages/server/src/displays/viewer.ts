/// <reference path="./viewer-assets.d.ts" />
import { brotliDecompressSync } from "node:zlib";
import viewerPath from "./assets/desktop-viewer.br" with { type: "file" };
import licensePath from "./assets/noVNC-LICENSE.br" with { type: "file" };

export const viewer = brotliDecompressSync(
  await Bun.file(new URL(viewerPath, import.meta.url)).arrayBuffer(),
).toString();
export const license = brotliDecompressSync(
  await Bun.file(new URL(licensePath, import.meta.url)).arrayBuffer(),
).toString();
export function desktopPage(control: boolean) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PocketCoder desktop</title><link rel="stylesheet" href="/viewer.css"></head><body data-control="${control}"><header>PocketCoder desktop · ${control ? "Control" : "View only"}<span id="status">Connecting…</span></header><main id="screen"></main><script type="module" src="/viewer.js"></script></body></html>`;
}
export const viewerCss =
  "html,body{margin:0;height:100%;background:#18202b;color:#fff;font:14px system-ui}body{display:flex;flex-direction:column}header{padding:12px 20px;display:flex;justify-content:space-between}main{flex:1;min-height:0}";
