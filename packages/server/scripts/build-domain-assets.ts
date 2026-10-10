import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { brotliCompressSync } from "node:zlib";

const library = resolve(dirname(Bun.resolveSync("tldts", import.meta.dir)), "../..");
const output = resolve(import.meta.dir, "../src/config/domains");
const trie = await import(resolve(library, "src/data/trie.ts"));
const data = {
  nodeFlags: Array.from(trie.nodeFlags),
  edgeStart: Array.from(trie.edgeStart),
  edgeChild: Array.from(trie.edgeChild),
  edgeLength: Array.from(trie.edgeLength),
  labelText: trie.labelText,
  rulesRoot: trie.rulesRoot,
  exceptionsRoot: trie.exceptionsRoot,
};
const license = await readFile(resolve(library, "LICENSE"), "utf8");
const source = await readFile(resolve(library, "src/suffix-trie.ts"), "utf8");
const lookup = `/* biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Keep the pinned upstream lookup unchanged. */
/* biome-ignore-all lint/style/noNonNullAssertion: Keep the pinned upstream lookup unchanged. */
// Generated from tldts 7.4.18. Run bun run domains:build.\n/*\n${license}\n*/\n${source.replace("'./data/trie'", "'./trie-data'")}`;
const formatted = Bun.spawnSync(["bunx", "biome", "check", "--write", "--stdin-file-path", "suffix-lookup.ts"], {
  stdin: Buffer.from(lookup),
  stdout: "pipe",
  stderr: "pipe",
});
if (formatted.exitCode !== 0) throw new Error(formatted.stderr.toString());
const assets = [
  ["trie.br", brotliCompressSync(JSON.stringify(data))],
  ["LICENSE.br", brotliCompressSync(license)],
  ["suffix-lookup.ts", formatted.stdout],
] as const;
for (const [name, bytes] of assets) {
  const path = resolve(output, name);
  if (process.argv.includes("--check")) {
    if (!(await readFile(path)).equals(bytes)) throw new Error("Run bun run domains:build to rebuild domain assets.");
  } else await writeFile(path, bytes);
}
