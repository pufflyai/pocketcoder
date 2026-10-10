/// <reference path="../../displays/viewer-assets.d.ts" />
import { brotliDecompressSync } from "node:zlib";
import licensePath from "./LICENSE.br" with { type: "file" };
import triePath from "./trie.br" with { type: "file" };

// Compression keeps the full ICANN and private suffix data within the native release budget.
const data = JSON.parse(
  brotliDecompressSync(await Bun.file(new URL(triePath, import.meta.url)).arrayBuffer()).toString(),
) as {
  nodeFlags: number[];
  edgeStart: number[];
  edgeChild: number[];
  edgeLength: number[];
  labelText: string;
  rulesRoot: number;
  exceptionsRoot: number;
};
export const nodeFlags = new Uint8Array(data.nodeFlags);
export const edgeStart = new Uint32Array(data.edgeStart);
export const edgeChild = new Uint32Array(data.edgeChild);
export const edgeLength = new Uint16Array(data.edgeLength);
export const labelText = data.labelText;
export const rulesRoot = data.rulesRoot;
export const exceptionsRoot = data.exceptionsRoot;
await Bun.file(new URL(licensePath, import.meta.url)).arrayBuffer();
