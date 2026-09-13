import { resolve } from "node:path";
import { launchSession, stopSession } from "./launcher";

const stateFlag = process.argv.indexOf("--state-dir");
const directory = resolve(stateFlag >= 0 ? (process.argv[stateFlag + 1] ?? "") : ".pocketcoder/resume-session");
const idleFlag = process.argv.indexOf("--idle-seconds");
const idleSeconds = idleFlag >= 0 ? Number(process.argv[idleFlag + 1]) : 60;
if (!Number.isInteger(idleSeconds) || idleSeconds < 10 || idleSeconds > 3600) {
  throw new Error("--idle-seconds must be between 10 and 3600");
}
if (process.argv.includes("--stop")) {
  await stopSession(directory);
} else if (process.argv.includes("--check")) {
  await import("./check-run");
} else {
  process.exitCode = await launchSession(
    directory,
    idleSeconds,
    process.argv.includes("--rpc"),
    process.argv.includes("--check-model"),
  );
}
