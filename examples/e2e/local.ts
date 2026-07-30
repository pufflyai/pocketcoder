import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { startFakePiGateway } from "../harnesses/pi/fake-gateway";
import { runHarnessE2E } from "./contract";

const ROOT = resolve(import.meta.dir, "../..");

interface CommandResult {
	stdout: string;
	stderr: string;
}

async function command(
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

async function bestEffort(args: string[]): Promise<void> {
	await command(args, { quiet: true }).catch(() => {});
}

function freePort(): number {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const port = Number(probe.port);
	probe.stop(true);
	return port;
}

async function waitFor(
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

function flag(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const harness = flag("--harness") ?? "echo";
if (!["echo", "pi"].includes(harness)) {
	throw new Error("--harness must be echo or pi");
}
if (
	harness === "pi" &&
	((process.env.PI_GATEWAY_URL && !process.env.PI_GATEWAY_MODEL) ||
		(!process.env.PI_GATEWAY_URL && process.env.PI_GATEWAY_MODEL))
) {
	throw new Error(
		"set both PI_GATEWAY_URL and PI_GATEWAY_MODEL, or neither to use the fake gateway",
	);
}

const runId = `${Date.now()}-${randomBytes(4).toString("hex")}`;
const tempDir = await mkdtemp(resolve(tmpdir(), "pocketcoder-example-"));
const postgresName = `pocketcoder-example-postgres-${runId}`;
const localImage = `pocketcoder-example-${harness}:${runId}`;
let postgresId = "";
let serverProcess: ReturnType<typeof Bun.spawn> | null = null;
let fakeGateway: ReturnType<typeof Bun.serve> | null = null;

async function cleanup(): Promise<void> {
	fakeGateway?.stop(true);
	if (serverProcess) {
		serverProcess.kill("SIGTERM");
		await Promise.race([serverProcess.exited, Bun.sleep(5000)]).catch(() => {});
	}
	if (postgresId) await bestEffort(["docker", "rm", "--force", postgresId]);
	await bestEffort(["docker", "image", "rm", "--force", localImage]);
	await rm(tempDir, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		void cleanup().finally(() => process.exit(130));
	});
}

try {
	await command(["docker", "version", "--format", "{{.Server.Version}}"], { quiet: true });
	postgresId = (
		await command(
			[
				"docker",
				"run",
				"--detach",
				"--name",
				postgresName,
				"--env",
				"POSTGRES_USER=pocketcoder",
				"--env",
				"POSTGRES_PASSWORD=pocketcoder",
				"--env",
				"POSTGRES_DB=pocketcoder",
				"--publish",
				"127.0.0.1::5432",
				"postgres:16-alpine",
			],
			{ quiet: true },
		)
	).stdout;

	const postgresPortOutput = await command(["docker", "port", postgresId, "5432/tcp"], {
		quiet: true,
	});
	const postgresPort = Number(postgresPortOutput.stdout.split(":").at(-1));
	if (!postgresPort) throw new Error("could not resolve the temporary PostgreSQL port");

	await waitFor(
		async () =>
			(await command(["docker", "exec", postgresId, "pg_isready", "-U", "pocketcoder"], {
				quiet: true,
			}).catch(() => null)) !== null,
		30_000,
		"PostgreSQL",
	);

	if (harness === "echo") {
		await command([
			"bun",
			"build",
			"apps/pocketcoder-agent/src/index.ts",
			"--target",
			"bun",
			"--outdir",
			"deploy/image/dist",
		]);
		await command(["docker", "build", "--tag", localImage, "deploy/image"]);
	} else {
		await command([
			"docker",
			"build",
			"--file",
			"examples/harnesses/pi/Dockerfile",
			"--tag",
			localImage,
			".",
		]);
	}
	const imageId = (
		await command(["docker", "image", "inspect", localImage, "--format", "{{.Id}}"], {
			quiet: true,
		})
	).stdout;
	if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
		throw new Error(`docker returned an invalid local image ID: ${imageId}`);
	}

	const templatePath = resolve(ROOT, `examples/harnesses/${harness}/template.json`);
	const template = JSON.parse(await readFile(templatePath, "utf8")) as {
		spec: {
			image: string;
			harness: { env?: Record<string, string> };
		};
	};
	template.spec.image = `${localImage}@${imageId}`;
	if (harness === "pi") {
		if (!process.env.PI_GATEWAY_URL) {
			fakeGateway = startFakePiGateway();
		}
		template.spec.harness.env = {
			...template.spec.harness.env,
			PI_GATEWAY_URL:
				process.env.PI_GATEWAY_URL ?? `http://host.docker.internal:${fakeGateway?.port ?? 0}/v1`,
			PI_GATEWAY_MODEL: process.env.PI_GATEWAY_MODEL ?? "pocketcoder-test",
			PI_GATEWAY_PROVIDER: process.env.PI_GATEWAY_PROVIDER ?? "pocketcoder-gateway",
		};
	}
	const templateDir = resolve(tempDir, "templates");
	await mkdir(templateDir, { recursive: true });
	await writeFile(resolve(templateDir, `${harness}.json`), JSON.stringify(template, null, 2));

	const databaseUrl = `postgres://pocketcoder:pocketcoder@127.0.0.1:${postgresPort}/pocketcoder`;
	const pepper = randomBytes(32).toString("base64url");
	const adminEnv = {
		POCKETCODER_DATABASE_URL: databaseUrl,
		POCKETCODER_AUTH_PEPPER: pepper,
	};
	await command(["bun", "packages/cli/src/index.ts", "db", "migrate"], {
		env: adminEnv,
	});
	await command(
		[
			"bun",
			"packages/cli/src/index.ts",
			"principals",
			"create",
			"--name",
			`example-${runId}`,
			"--scopes",
			"templates:read,workspaces:create,workspaces:read,workspaces:cancel,services:relay,logs:read",
			"--templates",
			"*",
		],
		{ env: adminEnv },
	);
	const issued = await command(
		[
			"bun",
			"packages/cli/src/index.ts",
			"keys",
			"issue",
			"--principal",
			`example-${runId}`,
			"--expires",
			"never",
		],
		{ env: adminEnv, quiet: true },
	);
	const key = issued.stdout
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith("pkt_"));
	if (!key) throw new Error("pocketcoderctl did not return a machine key");

	const serverPort = freePort();
	serverProcess = Bun.spawn(["bun", "apps/pocketcoder-server/src/index.ts"], {
		cwd: ROOT,
		env: {
			...process.env,
			...adminEnv,
			POCKETCODER_HOST: "127.0.0.1",
			POCKETCODER_PORT: String(serverPort),
			POCKETCODER_TEMPLATE_DIR: templateDir,
			POCKETCODER_INPUT_DIR: resolve(tempDir, "inputs"),
			POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${serverPort}`,
		},
		stdout: "inherit",
		stderr: "inherit",
	});
	const baseUrl = `http://127.0.0.1:${serverPort}`;
	await waitFor(
		async () => {
			if (serverProcess?.exitCode !== null) {
				throw new Error(`pocketcoder-server exited with ${serverProcess?.exitCode}`);
			}
			return await fetch(`${baseUrl}/v1/openapi.json`)
				.then((response) => response.ok)
				.catch(() => false);
		},
		30_000,
		"pocketcoder-server",
	);

	const report = await runHarnessE2E({
		baseUrl,
		key,
		template: `${harness}-harness`,
		prompt:
			process.env.POCKETCODER_EXAMPLE_PROMPT ??
			(harness === "echo" ? "hello from the local E2E" : "Reply with pocketcoder pi ok"),
		expectedResponse:
			process.env.POCKETCODER_EXAMPLE_EXPECT ??
			(harness === "echo"
				? "echo: hello from the local E2E"
				: fakeGateway
					? "pocketcoder pi ok"
					: undefined),
		readyTimeoutMs: harness === "echo" ? 120_000 : 300_000,
		messageTimeoutMs: harness === "echo" ? 60_000 : 600_000,
	});
	console.log("PocketCoder local harness E2E passed:");
	console.log(JSON.stringify(report, null, 2));
} finally {
	await cleanup();
}
