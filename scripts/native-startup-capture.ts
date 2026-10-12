import { closeSync, openSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startupSample } from "./native-startup-sample";

export async function captureStartup(command: string[], directory: string) {
  if (process.platform !== "linux") throw new Error("Startup sampling requires Linux /proc.");
  await mkdir(directory, { recursive: true });
  const stdout = openSync(join(directory, "result.json"), "w", 0o600);
  const stderr = openSync(join(directory, "controller.log"), "w", 0o600);
  const samples = await open(join(directory, "samples.jsonl"), "w", 0o600);
  const startedEpochMs = Date.now();
  let running = true;
  let count = 0;
  let failure: unknown;
  const child = Bun.spawn(command, { stdout, stderr, stdin: "ignore" });
  const sampling = (async () => {
    while (running) {
      await samples.write(`${JSON.stringify(await startupSample(child.pid))}\n`);
      count++;
      await Bun.sleep(100);
    }
  })().catch((error) => {
    failure = error;
  });
  let exitCode: number;
  try {
    exitCode = await child.exited;
  } finally {
    running = false;
    await sampling;
    await samples.close();
    closeSync(stdout);
    closeSync(stderr);
  }
  const record = {
    qualification: "Diagnostic sampling and tracing add overhead. No acceptance claim.",
    startedEpochMs,
    finishedEpochMs: Date.now(),
    pid: child.pid,
    exitCode,
    samples: count,
    sampler: { running, closed: true },
    samplingError: failure ? String(failure) : undefined,
  };
  await Bun.write(join(directory, "capture.json"), `${JSON.stringify(record, null, 2)}\n`);
  if (failure) throw failure;
  return record;
}

if (import.meta.main) {
  const [output, binary, runner] = process.argv.slice(2);
  if (!output || !binary || !runner)
    throw new Error("Usage: native-startup-capture.ts <evidence-directory> <normal-executable> <runner.js>");
  const directory = resolve(output);
  const result = await captureStartup(
    [
      "strace",
      "-ff",
      "-ttt",
      "-T",
      "-yy",
      "-e",
      "trace=fchmod,fsync,fdatasync,futex,wait4,waitid,epoll_wait,epoll_pwait,poll,ppoll,sched_yield",
      "-o",
      join(directory, "waits"),
      process.execPath,
      resolve(runner),
      resolve(binary),
      "--first-with-version",
    ],
    directory,
  );
  process.exitCode = result.exitCode;
}
