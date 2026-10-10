import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { brotliCompressSync } from "node:zlib";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "packages/server/src/displays/assets");
const result = await Bun.build({
  entrypoints: [resolve(root, "packages/server/src/displays/client/desktop-viewer.ts")],
  target: "browser",
  minify: true,
});
if (!result.success || !result.outputs[0]) throw new Error(String(result.logs));
const text = await result.outputs[0].text();
const bundle = brotliCompressSync(text);
const target = resolve(output, "desktop-viewer.br");
const library = resolve(root, "packages/server/node_modules/@novnc/novnc");
const notices = [
  "AUTHORS",
  "docs/LICENSE.MPL-2.0",
  "docs/LICENSE.BSD-2-Clause",
  "docs/LICENSE.BSD-3-Clause",
  "vendor/pako/LICENSE",
];
const licenses = await Promise.all(notices.map((path) => readFile(resolve(library, path), "utf8")));
const headers: string[] = [];
for await (const path of new Bun.Glob("{core,vendor}/**/*.js").scan({ cwd: library })) {
  const source = await readFile(resolve(library, path), "utf8");
  const header = source.match(/^\s*\/\*[\s\S]*?\*\//)?.[0];
  if (header && /copyright|license/i.test(header)) headers.push(`${path}\n${header}`);
}
headers.sort();
const license = `noVNC 1.7.0. Source: https://github.com/novnc/noVNC/tree/v1.7.0\nBundled without source changes.\n\n${licenses.join("\n\n")}\n\nSource notices\n${headers.join("\n\n")}`;
const noticeBundle = brotliCompressSync(license);
const licenseTarget = resolve(output, "noVNC-LICENSE.br");
if (process.argv.includes("--check")) {
  if (!(await readFile(target)).equals(bundle))
    throw new Error("Run bun scripts/build-desktop-viewer.ts to rebuild the viewer.");
  if (!(await readFile(licenseTarget)).equals(noticeBundle)) throw new Error("Rebuild desktop viewer license notices.");
} else {
  await mkdir(output, { recursive: true });
  await Bun.write(target, bundle);
  await Bun.write(licenseTarget, noticeBundle);
}
