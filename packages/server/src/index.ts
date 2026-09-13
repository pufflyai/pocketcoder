import { runPocketCoderServerUntilSignal } from "./lifecycle/lifecycle";

export {
  type RunningPocketCoderServer,
  runPocketCoderServerUntilSignal,
  type ServerLog,
  startPocketCoderServer,
} from "./lifecycle/lifecycle";

if (import.meta.main) {
  runPocketCoderServerUntilSignal().catch((error) => {
    console.error(`[pocketcoder-server] fatal: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
