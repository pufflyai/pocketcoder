import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

interface CommandResult {
	stdout: string;
	stderr: string;
}

export async function command(
	args: string[],
	options: { cwd?: string; env?: Record<string, string | undefined>; quiet?: boolean } = {},
): Promise<CommandResult> {
	const processHandle = Bun.spawn(args, {
		cwd: options.cwd ?? ROOT,
		env: { ...process.env, ...options.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	if (!options.quiet && stdout.trim()) console.log(stdout.trim());
	if (code !== 0) {
		throw new Error(`${args.join(" ")} failed (${code}): ${stderr.trim().slice(0, 2000)}`);
	}
	return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function bestEffort(args: string[]): Promise<void> {
	await command(args, { quiet: true }).catch(() => {});
}

export function freePort(): number {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const port = Number(probe.port);
	probe.stop(true);
	return port;
}

export async function waitFor(
	check: () => Promise<boolean>,
	timeoutMs: number,
	description: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(250);
	}
	throw new Error(`timed out waiting for ${description}`);
}

export function flag(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}
