import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface CliResult {
	exitCode: number;
	output: string;
}

interface RunCliOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
}

const pocketcoderEnvironment = [
	"POCKETCODER_AUTH_PEPPER",
	"POCKETCODER_DATABASE_SCHEMA",
	"POCKETCODER_DATABASE_URL",
	"POCKETCODER_KEY",
	"POCKETCODER_URL",
];

async function runCli(args: readonly string[], options: RunCliOptions = {}): Promise<CliResult> {
	const env: Record<string, string | undefined> = { ...Bun.env, NO_COLOR: "1" };
	for (const key of pocketcoderEnvironment) delete env[key];
	Object.assign(env, options.env);
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", resolve(import.meta.dir, "index.ts"), ...args],
		{
			cwd: options.cwd ?? resolve(import.meta.dir, ".."),
			env,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, output: `${stdout}${stderr}` };
}

describe("pocketcoderctl help", () => {
	test("prints root help successfully", async () => {
		const result = await runCli(["--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("pocketcoderctl <command>");
		expect(result.output).toContain("pocketcoderctl workspaces <command>");
	});

	test("a missing root command prints help and fails", async () => {
		const result = await runCli([]);

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("pocketcoderctl <command>");
		expect(result.output).toContain("A command is required.");
	});

	test.each(["db", "principals", "keys", "templates", "workspaces"])(
		"a missing %s subcommand prints group help and fails",
		async (group) => {
			const result = await runCli([group]);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(`pocketcoderctl ${group} <command>`);
			expect(result.output).toContain("Not enough non-option arguments");
		},
	);

	test.each([
		{
			args: ["principals", "create"],
			usage: "pocketcoderctl principals create",
			error: "Missing required arguments: name, scopes",
		},
		{
			args: ["keys", "issue"],
			usage: "pocketcoderctl keys issue",
			error: "Missing required argument: principal",
		},
		{
			args: ["keys", "revoke"],
			usage: "pocketcoderctl keys revoke",
			error: "Missing required argument: id",
		},
		{
			args: ["templates", "validate"],
			usage: "pocketcoderctl templates validate <files..>",
			error: "Not enough non-option arguments",
		},
		{
			args: ["workspaces", "create"],
			usage: "pocketcoderctl workspaces create",
			error: "Missing required argument: template",
		},
		{
			args: ["workspaces", "get"],
			usage: "pocketcoderctl workspaces get",
			error: "Missing required argument: id",
		},
		{
			args: ["workspaces", "logs"],
			usage: "pocketcoderctl workspaces logs",
			error: "Missing required argument: id",
		},
		{
			args: ["workspaces", "cancel"],
			usage: "pocketcoderctl workspaces cancel",
			error: "Missing required argument: id",
		},
		{
			args: ["doctor"],
			usage: "pocketcoderctl doctor",
			error: "Missing required argument: template",
		},
	])(
		"$usage prints command help when required arguments are missing",
		async ({ args, usage, error }) => {
			const result = await runCli(args);

			expect(result.exitCode).toBe(1);
			expect(result.output).toContain(usage);
			expect(result.output).toContain("Options:");
			expect(result.output).toContain(error);
		},
	);
});

describe("pocketcoderctl commands", () => {
	test("validates a template through the yargs command tree", async () => {
		const template = resolve(import.meta.dir, "../../../deploy/templates/fixture-echo.json");
		const result = await runCli(["templates", "validate", template]);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("fixture-echo@1.0.0");
		expect(result.output).toContain(": ok (");
	});
});

describe("pocketcoderctl environment", () => {
	test("loads .env from the nearest project directory", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
		const nested = join(directory, "nested");
		mkdirSync(nested);
		const authorizations: Array<string | null> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				authorizations.push(request.headers.get("authorization"));
				return Response.json({ items: [] });
			},
		});
		try {
			writeFileSync(
				join(directory, ".env"),
				`POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-dotenv\n`,
			);

			const result = await runCli(["workspaces", "list"], { cwd: nested });

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("(no workspaces)");
			expect(authorizations).toEqual(["Bearer from-dotenv"]);
		} finally {
			await server.stop(true);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("keeps exported environment variables above .env values", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
		const authorizations: Array<string | null> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				authorizations.push(request.headers.get("authorization"));
				return Response.json({ items: [] });
			},
		});
		try {
			writeFileSync(
				join(directory, ".env"),
				`POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-dotenv\n`,
			);

			const result = await runCli(["workspaces", "list"], {
				cwd: directory,
				env: { POCKETCODER_KEY: "from-shell" },
			});

			expect(result.exitCode).toBe(0);
			expect(authorizations).toEqual(["Bearer from-shell"]);
		} finally {
			await server.stop(true);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("supports explicit work directories and environment files", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-"));
		const invocationDirectory = mkdtempSync(join(tmpdir(), "pocketcoder-cli-cwd-"));
		const authorizations: Array<string | null> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				authorizations.push(request.headers.get("authorization"));
				return Response.json({ items: [] });
			},
		});
		try {
			writeFileSync(
				join(directory, "staging.env"),
				`POCKETCODER_URL=${server.url.origin}\nPOCKETCODER_KEY=from-explicit-file\n`,
			);

			const result = await runCli(
				["--workdir", directory, "--env-file", "staging.env", "workspaces", "list"],
				{ cwd: invocationDirectory },
			);

			expect(result.exitCode).toBe(0);
			expect(authorizations).toEqual(["Bearer from-explicit-file"]);
		} finally {
			await server.stop(true);
			rmSync(directory, { recursive: true, force: true });
			rmSync(invocationDirectory, { recursive: true, force: true });
		}
	});
});
