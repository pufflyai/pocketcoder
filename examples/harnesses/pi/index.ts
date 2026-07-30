import { PiHarness } from "./app";
import { createPiSession } from "./session";

const harness = new PiHarness(await createPiSession());
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.HARNESS_PORT ?? 3284),
	fetch: harness.fetch,
});

console.log(`pi-harness listening on 127.0.0.1:${server.port}`);

const launchInput = process.env.POCKETCODER_LAUNCH_INPUT;
if (launchInput) {
	try {
		const parsed = JSON.parse(launchInput) as { initial_prompt?: unknown };
		if (typeof parsed.initial_prompt === "string" && parsed.initial_prompt.trim()) {
			harness.submit(parsed.initial_prompt);
		}
	} catch {
		console.warn("pi-harness ignored invalid POCKETCODER_LAUNCH_INPUT");
	}
}

async function shutdown(): Promise<void> {
	server.stop(true);
	await harness.close();
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
