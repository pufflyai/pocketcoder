/// <reference path="./viewer-assets.d.ts" />
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import browserPath from "./assets/browser-viewer.br" with { type: "file" };
import viewerPath from "./assets/desktop-viewer.br" with { type: "file" };
import licensePath from "./assets/noVNC-LICENSE.br" with { type: "file" };

// Synchronous reads let the native CLI avoid asynchronous module setup at startup.
export const viewer = brotliDecompressSync(readFileSync(new URL(viewerPath, import.meta.url))).toString();
export const license = brotliDecompressSync(readFileSync(new URL(licensePath, import.meta.url))).toString();
export const browserViewer = brotliDecompressSync(readFileSync(new URL(browserPath, import.meta.url))).toString();
export function browserPage(control: boolean) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PocketCoder browser</title><link rel="stylesheet" href="/viewer.css"></head><body data-control="${control}"><header>PocketCoder browser · ${control ? "Control" : "View only"}<span id="status">Connecting…</span></header><form id="navigation"><input id="address" type="url" placeholder="https://example.com" required><button>Go</button></form><main id="screen"><img id="browser-screen" tabindex="0" alt="Workspace browser"></main><script type="module" src="/browser.js"></script></body></html>`;
}
export function desktopPage(control: boolean) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PocketCoder desktop</title><link rel="stylesheet" href="/viewer.css"></head><body data-control="${control}"><header>PocketCoder desktop · ${control ? "Control" : "View only"}<span id="status">Connecting…</span></header><main id="screen"></main><script type="module" src="/viewer.js"></script></body></html>`;
}
export const viewerCss =
  "html,body{margin:0;height:100%;background:#18202b;color:#fff;font:14px system-ui}body{display:flex;flex-direction:column}header{padding:12px 20px;display:flex;justify-content:space-between}main{flex:1;min-height:0}[hidden]{display:none}form{display:flex;padding:8px 20px;gap:8px}input{flex:1}#browser-screen{display:block;max-width:100%;max-height:none;width:100%;height:auto;object-fit:contain;object-position:top left;outline:none}";
