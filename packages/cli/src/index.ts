#!/usr/bin/env bun

import { type Flags, fail, loadProjectEnvironment } from "./cli-context";
import { createCli } from "./command-tree";
import { dispatchCommand } from "./dispatch";

export { createCli } from "./command-tree";

async function main() {
	const parsed = await createCli(process.argv.slice(2)).parseAsync();
	const [groupValue, actionValue] = parsed._;
	const group = groupValue === undefined ? undefined : String(groupValue);
	const action = actionValue === undefined ? undefined : String(actionValue);
	const positional = Array.isArray(parsed.files) ? parsed.files.map(String) : [];
	const flags = parsed as unknown as Flags;
	loadProjectEnvironment(flags);
	if (await dispatchCommand({ group, action, positional, flags })) return;
	fail(`unsupported command: ${[group, action].filter(Boolean).join(" ")}`);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(`pcd: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	});
}
