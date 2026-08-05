import { resolve } from "node:path";

export const OSS_E2E_HARNESSES = ["codex", "opencode"] as const;

async function runHarness(harness: (typeof OSS_E2E_HARNESSES)[number]): Promise<void> {
	const child = Bun.spawn(["bun", resolve(import.meta.dir, "local.ts"), "--harness", harness], {
		cwd: resolve(import.meta.dir, "../.."),
		env: process.env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`${harness} E2E failed with exit code ${exitCode}`);
}

if (import.meta.main) {
	for (const harness of OSS_E2E_HARNESSES) await runHarness(harness);
}
