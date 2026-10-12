import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyNativeArtifact } from "../examples/native/artifact";
import { nativeStartupHooks } from "./native-startup-hooks";

const originalCommit = "c9343fa1de5b507f4cbfd9f8f90dc734c73c2f77";
const originals = {
  x64: {
    bytes: 89_122_272,
    sha256: "dda7d0e889f2a7711b8102bf32c8dc6a86db9df3ddb1b8664e8b322aa4a39663",
    metadataSha256: "659bdd192c9a60c57a5c6d3a37ef6e9552c48d96b6efaa72e30f6b9294662b59",
    elfMachine: 62,
  },
  arm64: {
    bytes: 89_114_920,
    sha256: "ba9c1abdd6767152ca4a7f5a065e276b38b17e26495de8b77ecd761b5f1b5b09",
    metadataSha256: "75d6b054b21f95f22468d4af992e6550ec4ea90a5c3866b1420bd31a7f431ac7",
    elfMachine: 183,
  },
};
const originalHelpers = {
  "examples/native/controller.ts": "06cbb3014945f900bb948925bfcda633142556e838fc3b0a87f36522ffa896d7",
  "examples/native/artifact.ts": "e1ff44b7dd0876fd99a3a40e7b9b2a8e1efcf47549be1723f558996f31b08a32",
  "examples/native/ports.ts": "9bb6332941190a027077c46a6c0c569dbe7e101b58647ebab0df58e216537d3b",
};

async function record(path: string) {
  const bytes = await Bun.file(path).bytes();
  return { path, bytes: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}

async function git(args: string[]) {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code) throw new Error("Cannot bind diagnostic Git source");
  return stdout.trim();
}

const [artifact, output] = process.argv.slice(2);
if (!artifact || !output)
  throw new Error("Usage: native-startup-normal.ts <original-artifact-directory> <output-directory>");
if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64"))
  throw new Error("Normal-artifact diagnostic requires a supported Linux target");
const directory = resolve(output);
await mkdir(directory, { recursive: true });
const sourceCommit = await git(["rev-parse", "HEAD"]);
const sourceStatus = await git(["status", "--porcelain"]);
if (sourceStatus) throw new Error("Diagnostic source must be clean");
const original = originals[process.arch];
const native = await verifyNativeArtifact(resolve(artifact), originalCommit);
const metadata = await record(join(resolve(artifact), "native.json"));
if (native.bytes !== original.bytes || native.sha256 !== original.sha256 || metadata.sha256 !== original.metadataSha256)
  throw new Error("Normal executable differs from the original failed run");
await copyFile(metadata.path, join(directory, "original-native.json"));
const binary = join(resolve(artifact), "pocketcoder");
const header = await Bun.file(binary).slice(0, 20).bytes();
if (
  header[0] !== 127 ||
  header[1] !== 69 ||
  header[2] !== 76 ||
  header[3] !== 70 ||
  header[4] !== 2 ||
  header[5] !== 1 ||
  new DataView(header.buffer, header.byteOffset, header.byteLength).getUint16(18, true) !== original.elfMachine
)
  throw new Error("Original executable ELF target differs");
for (const [path, sha256] of Object.entries(originalHelpers)) {
  if ((await record(path)).sha256 !== sha256) throw new Error(`Original helper differs: ${path}`);
}
// Only the runner's log drain/spawn/exit hooks load. The original executable is never rebuilt or instrumented.
const built = await Bun.build({
  entrypoints: ["scripts/native-startup-runner.ts"],
  target: "bun",
  outdir: directory,
  naming: "runner.js",
  plugins: [nativeStartupHooks()],
});
if (!built.success) throw new AggregateError(built.logs, "Normal-artifact runner build failed");
const evidence = [];
for (const path of [
  binary,
  metadata.path,
  join(directory, "original-native.json"),
  join(directory, "runner.js"),
  ...Object.keys(originalHelpers),
  "scripts/native-startup-runner.ts",
  "scripts/native-startup-hooks.ts",
  "scripts/native-startup-normal.ts",
  "scripts/native-startup-capture.ts",
  "scripts/native-startup-sample.ts",
])
  evidence.push(await record(path));
await Bun.write(
  join(directory, "provenance.json"),
  `${JSON.stringify(
    {
      qualification:
        "Exact ordinary executable; diagnostic runner logging, sampling and tracing add overhead. No acceptance claim.",
      helperTransform:
        "The unchanged on-disk controller source is transformed only in the bundled runner to log controller lines, spawn and exit. The retained executable is untouched.",
      originalRun: "38111067349",
      originalCommit,
      sourceCommit,
      sourceStatus,
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      native,
      evidence,
    },
    null,
    2,
  )}\n`,
);
