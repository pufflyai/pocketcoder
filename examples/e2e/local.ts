import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { OSS_FIXTURE_CONTENT, startFakeOssGateway } from "../harnesses/oss/fake-gateway";
import { PI_FIXTURE_CONTENT, startFakePiGateway } from "../harnesses/pi/fake-gateway";
import { startOpenAIGateway } from "../harnesses/pi/openai-gateway";
import { LOCAL_PI_PRINCIPAL_SCOPES } from "../local/options";
import { buildLocalImage } from "../local/runtime";
import { createHarnessWorkspace, type ReadyHarnessWorkspace, runHarnessE2E } from "./contract";
import { bestEffort, command, flag, freePort, waitFor } from "./local-process";
import { serverOutput } from "./process-output";

const ROOT = resolve(import.meta.dir, "../..");

const harness = flag("--harness") ?? "echo";
if (!["echo", "pi", "codex", "opencode"].includes(harness)) {
	throw new Error("--harness must be echo, pi, codex, or opencode");
}
const ossHarness = harness === "codex" || harness === "opencode";
const localPiUi = process.argv.includes("--ui");
const useOpenAI = process.argv.includes("--openai");
const openAIApiKey = process.env.OPENAI_API_KEY;
const openAIModel = process.env.OPENAI_MODEL;
if ((localPiUi || useOpenAI) && harness !== "pi") {
	throw new Error("--ui and --openai require --harness pi");
}
if (useOpenAI && (process.env.PI_GATEWAY_URL || process.env.PI_GATEWAY_MODEL)) {
	throw new Error("--openai cannot be combined with PI_GATEWAY_URL or PI_GATEWAY_MODEL");
}
if (useOpenAI && !openAIApiKey) {
	throw new Error("OPENAI_API_KEY is required with --openai");
}
if (useOpenAI && !openAIModel) {
	throw new Error("OPENAI_MODEL is required with --openai");
}
if (
	harness === "pi" &&
	!useOpenAI &&
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
let localPiProcess: ReturnType<typeof Bun.spawn> | null = null;
let modelGateway: ReturnType<typeof Bun.serve> | null = null;
let usesFakeGateway = false;
let uiWorkspace: ReadyHarnessWorkspace | null = null;

async function cleanup(): Promise<void> {
	if (uiWorkspace) {
		await uiWorkspace.cancel().catch(() => {});
		uiWorkspace = null;
	}
	if (localPiProcess?.exitCode === null) {
		localPiProcess.kill("SIGTERM");
		await Promise.race([localPiProcess.exited, Bun.sleep(5000)]).catch(() => {});
	}
	modelGateway?.stop(true);
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
	}
	const { imageId } = await buildLocalImage({
		root: ROOT,
		imageTag: localImage,
		context: harness === "echo" ? "deploy/image" : ".",
		...(harness === "pi" ? { dockerfile: "examples/harnesses/pi/Dockerfile" } : {}),
		...(harness === "codex" || harness === "opencode"
			? { dockerfile: "examples/harnesses/oss/Dockerfile" }
			: {}),
		command,
	});

	const templatePath =
		harness === "echo"
			? resolve(ROOT, "examples/harnesses/echo/template.json")
			: resolve(ROOT, `examples/templates/${harness}-harness.json`);
	const template = JSON.parse(await readFile(templatePath, "utf8")) as {
		spec: {
			image: string;
			agent?: { command: string[]; env?: Record<string, string> };
			harness?: { env?: Record<string, string> };
		};
	};
	template.spec.image = `${localImage}@${imageId}`;
	if (harness === "pi") {
		// Fresh per run and only honored by the gateway process started below,
		// which dies with this script — the workspace never holds a credential
		// that outlives the run (docs/security.md).
		const gatewayBearer = process.env.PI_GATEWAY_BEARER ?? randomBytes(24).toString("base64url");
		if (useOpenAI) {
			modelGateway = startOpenAIGateway({
				apiKey: openAIApiKey ?? "",
				clientBearer: gatewayBearer,
				organization: process.env.OPENAI_ORGANIZATION,
				project: process.env.OPENAI_PROJECT,
			});
		} else if (!process.env.PI_GATEWAY_URL) {
			modelGateway = startFakePiGateway(gatewayBearer);
			usesFakeGateway = true;
		}
		if (!template.spec.agent) throw new Error("Pi template must use spec.agent");
		template.spec.agent.env = {
			...template.spec.agent.env,
			PI_GATEWAY_URL:
				process.env.PI_GATEWAY_URL ?? `http://host.docker.internal:${modelGateway?.port ?? 0}/v1`,
			PI_GATEWAY_MODEL:
				process.env.PI_GATEWAY_MODEL ?? (useOpenAI ? (openAIModel ?? "") : "pocketcoder-test"),
			PI_GATEWAY_PROVIDER:
				process.env.PI_GATEWAY_PROVIDER ??
				(useOpenAI ? "pocketcoder-openai" : "pocketcoder-gateway"),
			PI_GATEWAY_API:
				process.env.PI_GATEWAY_API ?? (useOpenAI ? "openai-responses" : "openai-completions"),
			PI_GATEWAY_BEARER: gatewayBearer,
		};
	}
	if (ossHarness) {
		// The bearer is scoped to this disposable gateway, which stops before
		// cleanup removes the workspace.
		const gatewayBearer = randomBytes(24).toString("base64url");
		modelGateway = startFakeOssGateway(gatewayBearer);
		usesFakeGateway = true;
		if (!template.spec.agent) throw new Error(`${harness} template must use spec.agent`);
		template.spec.agent.env = {
			...template.spec.agent.env,
			OSS_GATEWAY_URL: `http://host.docker.internal:${modelGateway.port}/v1`,
			OSS_GATEWAY_MODEL: "pocketcoder-test",
			OSS_GATEWAY_BEARER: gatewayBearer,
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
			LOCAL_PI_PRINCIPAL_SCOPES.join(","),
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
			// Bounded to the template's maxAge: an ephemeral run must not
			// mint credentials that outlive it (docs/security.md).
			"--expires",
			new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
		],
		{ env: adminEnv, quiet: true },
	);
	const key = issued.stdout
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith("pkt_"));
	if (!key) throw new Error("pcd did not return a machine key");

	const serverPort = freePort();
	const serverProcessOutput = serverOutput({
		interactive: localPiUi,
		debug: process.env.POCKETCODER_EXAMPLE_DEBUG === "1",
	});
	serverProcess = Bun.spawn(["bun", "apps/pocketcoder-server/src/index.ts"], {
		cwd: ROOT,
		env: {
			...process.env,
			...adminEnv,
			// Linux containers reach the host through the Docker bridge gateway,
			// so the E2E server must listen beyond the host loopback interface.
			POCKETCODER_HOST: "0.0.0.0",
			POCKETCODER_PORT: String(serverPort),
			POCKETCODER_TEMPLATE_DIR: templateDir,
			POCKETCODER_INPUT_DIR: resolve(tempDir, "inputs"),
			POCKETCODER_WORKSPACE_SERVER_URL: `http://host.docker.internal:${serverPort}`,
		},
		...serverProcessOutput,
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

	let defaultPrompt = `Reply with exactly: ${OSS_FIXTURE_CONTENT}`;
	if (harness === "echo") defaultPrompt = "hello from the local E2E";
	if (harness === "pi") {
		defaultPrompt =
			"Read /workspace/test.txt with the read tool. Reply with exactly the file contents and nothing else.";
	}
	const prompt = process.env.POCKETCODER_EXAMPLE_PROMPT ?? defaultPrompt;
	if (localPiUi) {
		uiWorkspace = await createHarnessWorkspace({
			baseUrl,
			key,
			template: "pi-harness",
			readyTimeoutMs: 300_000,
		});
		console.log(
			`Opening local Pi for workspace ${uiWorkspace.workspaceId}. Exit Pi to cancel and remove the workspace.`,
		);
		localPiProcess = Bun.spawn(["bun", resolve(ROOT, "packages/remote/src/bin.ts"), prompt], {
			cwd: ROOT,
			env: {
				...process.env,
				OPENAI_API_KEY: undefined,
				POCKETCODER_URL: baseUrl,
				POCKETCODER_KEY: key,
				POCKETCODER_WORKSPACE_ID: uiWorkspace.workspaceId,
			},
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		const exitCode = await localPiProcess.exited;
		localPiProcess = null;
		if (exitCode !== 0) throw new Error(`local Pi exited with code ${exitCode}`);
		const terminalState = await uiWorkspace.cancel();
		uiWorkspace = null;
		if (terminalState !== "canceled") {
			throw new Error(`expected canceled workspace, got ${terminalState}`);
		}
	} else {
		let expectedResponse = OSS_FIXTURE_CONTENT;
		if (harness === "echo") expectedResponse = "echo: hello from the local E2E";
		if (harness === "pi") expectedResponse = usesFakeGateway ? PI_FIXTURE_CONTENT : "";
		const report = await runHarnessE2E({
			baseUrl,
			key,
			template: `${harness}-harness`,
			prompt,
			expectedResponse: process.env.POCKETCODER_EXAMPLE_EXPECT ?? (expectedResponse || undefined),
			expectedConversation:
				harness === "echo"
					? [
							{ role: "user", content: prompt },
							{ role: "assistant", content: `echo: ${prompt}` },
						]
					: undefined,
			readyTimeoutMs: harness === "echo" ? 120_000 : 300_000,
			messageTimeoutMs: harness === "echo" ? 60_000 : 600_000,
			expectedLiveUpdates: usesFakeGateway ? 2 : undefined,
		});
		console.log("PocketCoder local harness E2E passed:");
		console.log(JSON.stringify(report, null, 2));
	}
} finally {
	await cleanup();
}
