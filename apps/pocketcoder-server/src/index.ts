import { runPocketcoderServerUntilSignal } from "./lifecycle";

export * from "./lifecycle";

if (import.meta.main) {
	runPocketcoderServerUntilSignal().catch((error) => {
		console.error(`[pocketcoder-server] fatal: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	});
}
