import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig, type ServerConfig } from "@pstdio/pocketcoder-server/config";
import { runPocketcoderServerUntilSignal } from "@pstdio/pocketcoder-server/lifecycle";

interface ServerState {
	version: 1;
	pid: number;
	instanceToken: string;
	url: string;
	startedAt: string;
	configFingerprint: string;
	logPath: string;
}

export interface ServerProcessOptions {
	foreground?: boolean;
	json?: boolean;
	timeoutSeconds?: number;
	instanceToken?: string;
}

function stateRoot(): string {
	return resolve(
		process.env.POCKETCODER_STATE_DIR ?? join(homedir(), ".local", "state", "pocketcoder"),
	);
}

function statePath(): string {
	return join(stateRoot(), "server.json");
}

function logPath(): string {
	return join(stateRoot(), "server.log");
}

function stateFromJson(value: unknown): ServerState | null {
	if (!value || typeof value !== "object") return null;
	const row = value as Partial<ServerState>;
	if (
		row.version !== 1 ||
		typeof row.pid !== "number" ||
		!Number.isSafeInteger(row.pid) ||
		row.pid <= 0 ||
		typeof row.instanceToken !== "string" ||
		typeof row.url !== "string" ||
		typeof row.startedAt !== "string" ||
		typeof row.configFingerprint !== "string" ||
		typeof row.logPath !== "string"
	) {
		return null;
	}
	return row as ServerState;
}

function readState(): ServerState | null {
	try {
		return stateFromJson(JSON.parse(readFileSync(statePath(), "utf8")));
	} catch {
		return null;
	}
}

function writeState(state: ServerState): void {
	const path = statePath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, path);
}

function removeState(): void {
	rmSync(statePath(), { force: true });
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function processCommand(pid: number): string | null {
	const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
		encoding: "utf8",
		timeout: 2000,
	});
	if (result.status !== 0) return null;
	const command = result.stdout.trim();
	return command || null;
}

function processIdentityMatches(state: ServerState): boolean {
	if (!processExists(state.pid)) return false;
	return processCommand(state.pid)?.includes(state.instanceToken) ?? false;
}

async function healthIdentity(url: string): Promise<string | null> {
	try {
		const response = await fetch(`${url}/readyz`, {
			signal: AbortSignal.timeout(2000),
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { instance_id?: unknown };
		return typeof body.instance_id === "string" ? body.instance_id : null;
	} catch {
		return null;
	}
}

function configUrl(config: ServerConfig): string {
	const host =
		config.listenHost === "0.0.0.0" || config.listenHost === "::" ? "127.0.0.1" : config.listenHost;
	return `http://${host}:${config.listenPort}`;
}

function configFingerprint(config: ServerConfig): string {
	const safeConfig = {
		listenHost: config.listenHost,
		listenPort: config.listenPort,
		storeKind: config.storeKind,
		databaseSchema: config.databaseSchema,
		templateDir: config.templateDir,
		driverKind: config.driverKind,
		inputDir: config.inputDir,
		storageBackend: config.storageBackend,
		secretProvider: config.secretProvider,
		workspaceServerUrl: config.workspaceServerUrl,
	};
	return createHash("sha256").update(JSON.stringify(safeConfig)).digest("hex");
}

function selfInvocation(args: string[]): string[] {
	const candidate = process.argv[1];
	if (candidate && existsSync(candidate) && /\.[cm]?[jt]s$/.test(candidate)) {
		return [process.execPath, "--no-env-file", resolve(candidate), ...args];
	}
	return [process.execPath, ...args];
}

function logTail(path: string): string {
	try {
		const content = readFileSync(path, "utf8");
		return content.slice(Math.max(0, content.length - 4000)).trim();
	} catch {
		return "";
	}
}

async function waitForStarted(state: ServerState, timeoutSeconds: number): Promise<void> {
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		if (!processIdentityMatches(state)) {
			throw new Error("server process exited before becoming healthy");
		}
		if ((await healthIdentity(state.url)) === state.instanceToken) return;
		await Bun.sleep(100);
	}
	throw new Error(`server did not become healthy within ${timeoutSeconds} seconds`);
}

function timeoutSeconds(value: number | undefined, fallback: number): number {
	const timeout = value ?? fallback;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) {
		throw new Error("--timeout-seconds must be an integer from 1 to 60");
	}
	return timeout;
}

export async function startManagedServer(options: ServerProcessOptions): Promise<void> {
	if (options.foreground) {
		await runPocketcoderServerUntilSignal(loadConfig());
		return;
	}

	const existing = readState();
	if (existing && processIdentityMatches(existing)) {
		throw new Error(`server is already running (pid ${existing.pid}, ${existing.url})`);
	}
	if (existing) removeState();

	const config = loadConfig();
	const instanceToken = randomUUID();
	const state: ServerState = {
		version: 1,
		pid: 0,
		instanceToken,
		url: configUrl(config),
		startedAt: new Date().toISOString(),
		configFingerprint: configFingerprint(config),
		logPath: logPath(),
	};

	mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
	const output = openSync(state.logPath, "a", 0o600);
	try {
		const command = selfInvocation(["server", "run", "--instance-token", instanceToken]);
		const child = spawn(command[0] as string, command.slice(1), {
			cwd: process.cwd(),
			detached: true,
			env: process.env,
			stdio: ["ignore", output, output],
		});
		if (!child.pid) throw new Error("could not start the server process");
		state.pid = child.pid;
		writeState(state);
		child.unref();
	} finally {
		closeSync(output);
	}

	try {
		await waitForStarted(state, timeoutSeconds(options.timeoutSeconds, 30));
	} catch (error) {
		if (processIdentityMatches(state)) process.kill(state.pid, "SIGTERM");
		removeState();
		const evidence = logTail(state.logPath);
		throw new Error(
			`${error instanceof Error ? error.message : error}${evidence ? `\n${evidence}` : ""}`,
		);
	}

	console.log(`pocketcoder-server started (pid ${state.pid})`);
	console.log(`url: ${state.url}`);
	console.log(`log: ${state.logPath}`);
}

export async function runManagedServer(instanceToken: string): Promise<void> {
	await runPocketcoderServerUntilSignal(loadConfig(), { instanceId: instanceToken });
}

export async function printManagedServerStatus(json: boolean): Promise<void> {
	const state = readState();
	if (!state) throw new Error("server is not running (no managed server state)");
	const identityMatches = processIdentityMatches(state);
	const healthy = identityMatches && (await healthIdentity(state.url)) === state.instanceToken;
	const result = {
		state: healthy ? "running" : identityMatches ? "unhealthy" : "stale",
		pid: state.pid,
		url: state.url,
		started_at: state.startedAt,
		config_fingerprint: state.configFingerprint,
		log: state.logPath,
	};
	if (json) console.log(JSON.stringify(result, null, 2));
	else {
		console.log(
			`${result.state}\tpid=${result.pid}\turl=${result.url}\tstarted=${result.started_at}`,
		);
	}
	if (!healthy) throw new Error(`managed server state is ${result.state}`);
}

export async function stopManagedServer(options: ServerProcessOptions): Promise<void> {
	const state = readState();
	if (!state) throw new Error("server is not running (no managed server state)");
	if (!processExists(state.pid)) {
		removeState();
		console.log(`removed stale server state for pid ${state.pid}`);
		return;
	}
	if (!processIdentityMatches(state)) {
		throw new Error(`refusing to stop pid ${state.pid}: process identity does not match`);
	}

	process.kill(state.pid, "SIGTERM");
	const timeout = timeoutSeconds(options.timeoutSeconds, 15);
	const deadline = Date.now() + timeout * 1000;
	while (Date.now() < deadline) {
		if (!processExists(state.pid)) {
			removeState();
			console.log(`pocketcoder-server stopped (pid ${state.pid})`);
			return;
		}
		await Bun.sleep(100);
	}
	throw new Error(`server pid ${state.pid} did not stop within ${timeout} seconds`);
}
