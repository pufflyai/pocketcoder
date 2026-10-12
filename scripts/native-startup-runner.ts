import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeController } from "../examples/native/controller";

const [binary, mode] = process.argv.slice(2);
if (!binary || (mode && mode !== "--first-only" && mode !== "--first-with-version")) {
  throw new Error("Usage: native-startup-runner.ts <executable> [--first-only|--first-with-version]");
}
const directory = await mkdtemp(join(tmpdir(), "pc105-startup-profile-"));
const controller = await nativeController(binary, directory);
const startedEpochMs = Date.now();
let failure: unknown;
let prelude: { startedEpochMs: number; finishedEpochMs: number; output: string } | undefined;
let firstStartedEpochMs: number | undefined;
const cleanup = { stopped: false, removed: false };
try {
  if (mode !== "--first-only") {
    const startedEpochMs = Date.now();
    const output = await controller.run(["--version"]);
    prelude = { startedEpochMs, finishedEpochMs: Date.now(), output };
  }
  firstStartedEpochMs = Date.now();
  await controller.start();
  await controller.stop();
  if (!mode) {
    await controller.start();
    await controller.stop();
  }
} catch (error) {
  failure = error;
} finally {
  try {
    await controller.stop();
    cleanup.stopped = true;
  } catch (error) {
    failure ??= error;
  }
  try {
    await rm(directory, { recursive: true, force: true });
    cleanup.removed = true;
  } catch (error) {
    failure ??= error;
  }
}
console.log(
  JSON.stringify({
    qualification: "Diagnostic only. Process CPU phases overlap; tracing adds overhead. No acceptance claim.",
    firstOnly: Boolean(mode),
    prelude,
    firstStartedEpochMs,
    directory,
    startedEpochMs,
    finishedEpochMs: Date.now(),
    error: failure ? String(failure) : undefined,
    measurements: controller.measurements,
    cleanup,
  }),
);
if (failure) process.exitCode = 1;
