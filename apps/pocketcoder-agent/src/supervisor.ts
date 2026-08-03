import { randomUUID } from "node:crypto";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type AgentFrame,
	type ExecSpec,
	HEADER_POOL_ENROLLMENT,
	HEADER_POOL_RUNTIME,
	HEADER_PROTOCOL,
	HEADER_RECONNECT,
	HEADER_REGISTRATION,
	HEADER_WORKSPACE,
	LeaseAssignmentFrameSchema,
	POOL_PROTOCOL_VERSION,
	type PoolProviderInput,
	PROTOCOL_VERSION,
	ProviderBootstrapInputSchema,
	type ProviderInput,
	type ProxyRequest,
	parseDurationMs,
	ServerFrameSchema,
} from "@pstdio/pocketcoder-contracts";

// pocketcoder-agent supervise: PID 1 inside every workspace. It registers with
// pocketcoder-server over one outbound WSS connection, runs the template's
// setup commands, supervises the harness process, probes declared loopback
// services, forwards bounded logs, and answers allowlisted relay requests.

export const AGENT_VERSION = "0.1.0";

// Stable supervisor exit codes for outcomes that are not the child's own.
export const EXIT_SETUP_FAILED = 30;
export const EXIT_REGISTRATION_FAILED = 31;
export const EXIT_PROTOCOL_ERROR = 32;
export const EXIT_WRITABLE_MEMORY_FAILED = 33;

const LOG_CHUNK_LIMIT = 32 * 1024;
const HEALTH_INTERVAL_MS = 5000;

type ChildPhase = "starting" | "setup" | "running" | "exited" | "terminating";

interface AgentApiStatus {
	state: "unknown" | "stable" | "running";
}

export async function verifyWritableMemoryPaths(paths: string[]): Promise<void> {
	for (const path of paths) {
		const probePath = join(path, `.pocketcoder-write-probe-${randomUUID()}`);
		const expected = randomUUID();
		let handle: Awaited<ReturnType<typeof open>> | null = null;
		try {
			handle = await open(probePath, "wx", 0o600);
			await handle.writeFile(expected, "utf8");
			await handle.sync();
			await handle.close();
			handle = null;
			const actual = await readFile(probePath, "utf8");
			if (actual !== expected) {
				throw new Error("read-back content did not match");
			}
			await rm(probePath);
		} catch (error) {
			throw new Error(
				`writable memory preflight failed for ${path}: ${
					error instanceof Error ? error.message : "unknown error"
				}`,
				{ cause: error },
			);
		} finally {
			await handle?.close().catch(() => {});
			await rm(probePath, { force: true }).catch(() => {});
		}
	}
}

export async function pumpLineFramedText(
	stream: ReadableStream<Uint8Array>,
	emit: (text: string) => void,
	capture?: (value: Uint8Array) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			capture?.(value);
			pending += decoder.decode(value, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				emit(pending.slice(0, newline + 1));
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
		}
	} catch {
		// Stream ended with the process.
	} finally {
		pending += decoder.decode();
		if (pending !== "") emit(pending);
	}
}

export function splitUtf8Chunks(text: string, maxBytes = LOG_CHUNK_LIMIT): string[] {
	const chunks: string[] = [];
	let chunk = "";
	let chunkBytes = 0;
	for (const character of text) {
		const bytes = Buffer.byteLength(character);
		if (chunkBytes + bytes > maxBytes && chunk !== "") {
			chunks.push(chunk);
			chunk = "";
			chunkBytes = 0;
		}
		chunk += character;
		chunkBytes += bytes;
	}
	if (chunk !== "") chunks.push(chunk);
	return chunks;
}

export async function supervise(inputPath: string): Promise<number> {
	const raw = await Bun.file(inputPath).text();
	const bootstrap = ProviderBootstrapInputSchema.parse(JSON.parse(raw));
	const input: ProviderInput =
		"pool_runtime_id" in bootstrap ? await waitForPoolLease(bootstrap) : bootstrap;
	const supervisor = new Supervisor(input);
	return await supervisor.run();
}

export function waitForPoolLease(input: PoolProviderInput): Promise<ProviderInput> {
	return new Promise((resolve, reject) => {
		const base = input.server_url.replace(/^http/, "ws").replace(/\/$/, "");
		const ws = new WebSocket(`${base}/v1/agent/pool-connect`, {
			headers: {
				[HEADER_PROTOCOL]: String(POOL_PROTOCOL_VERSION),
				[HEADER_POOL_RUNTIME]: input.pool_runtime_id,
				[HEADER_POOL_ENROLLMENT]: input.enrollment_secret,
			},
		} as unknown as string[]);
		let assigned = false;
		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					v: POOL_PROTOCOL_VERSION,
					type: "pool_registered",
					pool_runtime_id: input.pool_runtime_id,
					template: {
						name: input.template_name,
						version: input.template_version,
						digest: input.template_digest,
					},
					agent_version: AGENT_VERSION,
				}),
			);
		};
		ws.onmessage = (event) => {
			const parsed = LeaseAssignmentFrameSchema.safeParse(JSON.parse(String(event.data)));
			if (!parsed.success || assigned) return;
			assigned = true;
			ws.close(1000, "lease received");
			resolve(parsed.data.input);
		};
		ws.onerror = () => {};
		ws.onclose = () => {
			if (!assigned) reject(new Error("warm pool enrollment closed before assignment"));
		};
	});
}

class Supervisor {
	private readonly input: ProviderInput;
	private ws: WebSocket | null = null;
	private connectionId = "";
	private seq = 0;
	private reconnectCredential: string | null = null;
	private exec: ExecSpec | null = null;
	private child: ReturnType<typeof Bun.spawn> | null = null;
	private childPhase: ChildPhase = "starting";
	private childExit: number | null = null;
	private shuttingDown = false;
	private agentapi: AgentApiStatus = { state: "unknown" };
	private readonly health = new Map<string, string>();
	private readonly done: Promise<number>;
	private finish!: (code: number) => void;
	private timers: Array<ReturnType<typeof setInterval>> = [];
	private execReady!: () => void;
	private readonly execReadyPromise: Promise<void>;

	constructor(input: ProviderInput) {
		this.input = input;
		this.done = new Promise((resolve) => {
			this.finish = resolve;
		});
		this.execReadyPromise = new Promise((resolve) => {
			this.execReady = resolve;
		});
	}

	private wsUrl(): string {
		const base = this.input.server_url.replace(/^http/, "ws").replace(/\/$/, "");
		return `${base}/v1/agent/connect`;
	}

	async run(): Promise<number> {
		this.connect(true);
		// Wait until the server delivered the exec spec, then run setup and
		// start the harness exactly once. Registration failure resolves
		// `done` first, so a rejected connection cannot hang the supervisor.
		const raced = await Promise.race([this.execReadyPromise.then(() => null), this.done]);
		if (raced !== null) return raced;
		const exec = this.exec;
		if (!exec) return EXIT_PROTOCOL_ERROR;

		if (exec.launch_mode === "restore") {
			this.sendFrame("restore_status", {
				phase: "validating",
				capability: exec.persistence.conversation_restore,
			});
		}
		const memoryOk = await this.probeWritableMemory(exec);
		if (!memoryOk) {
			this.sendFrame("process_state", {
				phase: "exited",
				exit_code: EXIT_WRITABLE_MEMORY_FAILED,
				setup_step: this.failedSetupStep ?? "writable-memory-preflight",
			});
			await this.flushAndClose();
			return EXIT_WRITABLE_MEMORY_FAILED;
		}
		const setupOk = await this.runSetup(exec);
		if (!setupOk) {
			this.sendFrame("process_state", {
				phase: "exited",
				exit_code: EXIT_SETUP_FAILED,
				setup_step: this.failedSetupStep ?? "setup",
			});
			await this.flushAndClose();
			return EXIT_SETUP_FAILED;
		}
		await this.reportResolvedSource(exec);
		if (exec.launch_mode === "restore") {
			this.sendFrame("restore_status", {
				phase: "ready",
				capability: exec.persistence.conversation_restore,
			});
		}
		this.startHarness(exec);
		this.startHealthLoop(exec);
		this.startHeartbeatLoop();
		return await this.done;
	}

	// --- Connection ---

	private connect(first: boolean): void {
		const headers: Record<string, string> = {
			[HEADER_PROTOCOL]: String(PROTOCOL_VERSION),
			[HEADER_WORKSPACE]: this.input.workspace_id,
		};
		if (first || !this.reconnectCredential) {
			headers[HEADER_REGISTRATION] = this.input.registration_secret;
		} else {
			headers[HEADER_RECONNECT] = this.reconnectCredential;
		}
		this.connectionId = randomUUID();
		this.seq = 0;
		const ws = new WebSocket(this.wsUrl(), { headers } as unknown as string[]);
		this.ws = ws;
		ws.onopen = () => {
			this.sendFrame("registered", {
				agent_version: AGENT_VERSION,
				template: {
					name: this.input.template_name,
					version: this.input.template_version,
					digest: this.input.template_digest,
				},
				services: this.exec ? Object.keys(this.exec.services) : [],
				pid: process.pid,
			});
		};
		ws.onmessage = (event) => {
			void this.handleMessage(String(event.data));
		};
		ws.onclose = () => {
			if (this.shuttingDown || this.childExit !== null) return;
			if (!this.reconnectCredential) {
				// Registration never completed; the workspace will fail with
				// registration_timeout on the server side.
				this.exitWith(EXIT_REGISTRATION_FAILED);
				return;
			}
			setTimeout(() => {
				if (!this.shuttingDown && this.childExit === null) this.connect(false);
			}, 2000);
		};
		ws.onerror = () => {
			// onclose follows; reconnect logic lives there.
		};
	}

	private sendFrame(type: AgentFrame["type"], payload: unknown): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.seq += 1;
		this.ws.send(
			JSON.stringify({
				v: PROTOCOL_VERSION,
				type,
				workspace_id: this.input.workspace_id,
				connection_id: this.connectionId,
				seq: this.seq,
				sent_at: new Date().toISOString(),
				payload,
			}),
		);
	}

	private async handleMessage(raw: string): Promise<void> {
		const parsed = ServerFrameSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) return;
		const frame = parsed.data;
		switch (frame.type) {
			case "registered_ack": {
				if (frame.payload.reconnect_credential) {
					this.reconnectCredential = frame.payload.reconnect_credential;
				}
				if (this.agentapi.state !== "unknown") {
					this.sendFrame("agent_state", { state: this.agentapi.state });
				}
				if (!this.exec) {
					this.exec = frame.payload.exec;
					this.execReady();
				}
				return;
			}
			case "proxy_request":
				await this.handleProxy(frame.payload);
				return;
			case "signal": {
				this.forwardSignal(frame.payload.signal === "KILL" ? "SIGKILL" : "SIGTERM");
				this.sendFrame("termination_ack", { phase: "term_sent" });
				return;
			}
			case "health_probe": {
				const exec = this.exec;
				if (exec) await this.probeService(exec, frame.payload.service, true);
				return;
			}
			case "shutdown": {
				await this.gracefulShutdown();
				return;
			}
			case "prepare_checkpoint": {
				await this.prepareCheckpoint(frame.payload.operation_id, frame.payload.deadline_ms);
				return;
			}
		}
	}

	// --- Setup commands ---

	private failedSetupStep: string | null = null;

	private async probeWritableMemory(exec: ExecSpec): Promise<boolean> {
		try {
			await verifyWritableMemoryPaths(exec.security.writable_memory_paths);
			return true;
		} catch (error) {
			this.failedSetupStep = "writable-memory-preflight";
			this.log(error instanceof Error ? error.message : "writable memory preflight failed");
			return false;
		}
	}

	private async runSetup(exec: ExecSpec): Promise<boolean> {
		for (const step of exec.setup) {
			this.childPhase = "setup";
			this.sendFrame("process_state", { phase: "setup", setup_step: step.name });
			// An explicit cwd avoids EACCES from posix_spawn when the image's
			// default working directory is not accessible to the workspace uid.
			const proc = Bun.spawn(step.command, {
				cwd: step.cwd ?? exec.harness.cwd ?? "/",
				env: {
					...process.env,
					...exec.env,
					...step.env,
					POCKETCODER_LAUNCH_MODE: exec.launch_mode,
					...(exec.source ? { POCKETCODER_SOURCE: JSON.stringify(exec.source) } : {}),
					...(exec.restore ? { POCKETCODER_RESTORE: JSON.stringify(exec.restore) } : {}),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const pumps = [
				this.pumpStream(proc.stdout, "stdout"),
				this.pumpStream(proc.stderr, "stderr"),
			];
			const timeout = setTimeout(() => proc.kill("SIGKILL"), step.timeoutSeconds * 1000);
			const code = await proc.exited;
			clearTimeout(timeout);
			await Promise.all(pumps);
			if (code !== 0) {
				this.failedSetupStep = step.name;
				this.log(`setup step ${step.name} failed with exit code ${code}`);
				return false;
			}
		}
		return true;
	}

	private async reportResolvedSource(exec: ExecSpec): Promise<void> {
		if (!exec.source) return;
		try {
			const proc = Bun.spawn(
				["git", "-C", exec.source.destination, "rev-parse", "--verify", "HEAD"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
			const commit = stdout.trim().toLowerCase();
			if (code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
				throw new Error("git did not return an immutable commit");
			}
			this.sendFrame("source_resolved", {
				repository: exec.source.repository,
				requested_revision: exec.source.revision,
				resolved_commit: commit,
			});
		} catch (error) {
			this.log(
				`source resolution failed: ${error instanceof Error ? error.message : "unknown error"}`,
			);
		}
	}

	private async prepareCheckpoint(operationId: string, deadlineMs: number): Promise<void> {
		const hook = this.exec?.checkpoint_hook;
		this.sendFrame("checkpoint_status", {
			operation_id: operationId,
			phase: "quiescing",
		});
		if (!hook) {
			this.sendFrame("checkpoint_status", {
				operation_id: operationId,
				phase: "failed",
				detail: "template has no checkpoint hook",
			});
			return;
		}
		try {
			const proc = Bun.spawn(hook.command, {
				cwd: hook.cwd ?? this.exec?.harness.cwd ?? "/",
				env: {
					...process.env,
					...this.exec?.env,
					...hook.env,
					POCKETCODER_CHECKPOINT_OPERATION: operationId,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const pumps = [
				this.pumpStream(proc.stdout, "stdout"),
				this.pumpStream(proc.stderr, "stderr"),
			];
			const timeout = setTimeout(
				() => proc.kill("SIGKILL"),
				Math.min(deadlineMs, hook.timeout_seconds * 1000),
			);
			const code = await proc.exited;
			clearTimeout(timeout);
			await Promise.all(pumps);
			this.sendFrame("checkpoint_status", {
				operation_id: operationId,
				phase: code === 0 ? "quiesced" : "failed",
				...(code === 0 ? {} : { detail: `checkpoint hook exited ${code}` }),
			});
		} catch (error) {
			this.sendFrame("checkpoint_status", {
				operation_id: operationId,
				phase: "failed",
				detail: error instanceof Error ? error.message.slice(0, 512) : "hook failed",
			});
		}
	}

	// --- Harness ---

	private startHarness(exec: ExecSpec): void {
		this.childPhase = "running";
		this.sendFrame("process_state", { phase: "running" });
		// The caller's opaque launch input reaches the harness in memory
		// only; it is never written to the workspace filesystem by the
		// supervisor and the server erases its copy at readiness.
		const child = Bun.spawn(exec.harness.command, {
			cwd: exec.harness.cwd ?? "/",
			env: {
				...process.env,
				...exec.env,
				...exec.harness.env,
				POCKETCODER_LAUNCH_MODE: exec.launch_mode,
				...(exec.source ? { POCKETCODER_SOURCE: JSON.stringify(exec.source) } : {}),
				...(exec.restore ? { POCKETCODER_RESTORE: JSON.stringify(exec.restore) } : {}),
				...(this.input.launch_input
					? { POCKETCODER_LAUNCH_INPUT: JSON.stringify(this.input.launch_input) }
					: {}),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		this.child = child;
		const pumps = [
			this.pumpStream(child.stdout, "stdout"),
			this.pumpStream(child.stderr, "stderr"),
		];
		void child.exited.then(async (code) => {
			this.childPhase = "exited";
			this.childExit = code;
			await Promise.all(pumps);
			this.sendFrame("process_state", { phase: "exited", exit_code: code });
			await this.flushAndClose();
			this.exitWith(code);
		});
	}

	private forwardSignal(signal: "SIGTERM" | "SIGKILL"): void {
		this.childPhase = "terminating";
		if (this.child && this.childExit === null) {
			this.child.kill(signal);
		} else if (this.childExit !== null) {
			this.exitWith(this.childExit);
		} else {
			this.exitWith(0);
		}
	}

	private async gracefulShutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		const exec = this.exec;
		const graceMs = exec ? parseDurationMs(exec.timeouts.terminateGrace) : 15_000;
		this.forwardSignal("SIGTERM");
		if (this.child && this.childExit === null) {
			const timer = setTimeout(() => {
				if (this.childExit === null) {
					this.sendFrame("termination_ack", { phase: "killed" });
					this.child?.kill("SIGKILL");
				}
			}, graceMs);
			await this.child.exited;
			clearTimeout(timer);
		}
		this.sendFrame("termination_ack", { phase: "exited" });
	}

	// --- Relay ---

	private async handleProxy(request: ProxyRequest): Promise<void> {
		const exec = this.exec;
		const service = exec?.services[request.service];
		const route = service?.routes.find(
			(r) => r.method === request.method && r.path === request.path,
		);
		if (!service || !route) {
			this.sendFrame("proxy_response", {
				request_id: request.request_id,
				headers: {},
				error_code: "unreachable",
			});
			return;
		}
		const beginsAgentTurn =
			request.service === "agent" && request.method === "POST" && request.path === "/message";
		if (beginsAgentTurn) this.setAgentState("running");
		const url = new URL(request.path, service.baseUrl);
		for (const [key, value] of Object.entries(request.query)) {
			url.searchParams.set(key, value);
		}
		try {
			const res = await fetch(url, {
				method: request.method,
				headers: request.headers,
				...(request.body_b64 ? { body: Buffer.from(request.body_b64, "base64") } : {}),
				signal: AbortSignal.timeout(request.deadline_ms),
			});
			const body = Buffer.from(await res.arrayBuffer());
			if (body.byteLength > route.maxResponseBytes) {
				this.sendFrame("proxy_response", {
					request_id: request.request_id,
					headers: {},
					error_code: "too_large",
				});
				return;
			}
			this.sendFrame("proxy_response", {
				request_id: request.request_id,
				status: res.status,
				headers: res.headers.get("content-type")
					? { "content-type": res.headers.get("content-type") as string }
					: {},
				...(body.byteLength > 0 ? { body_b64: body.toString("base64") } : {}),
			});
			if (beginsAgentTurn && exec) void this.probeService(exec, "agent", true);
		} catch (err) {
			this.sendFrame("proxy_response", {
				request_id: request.request_id,
				headers: {},
				error_code:
					err instanceof Error && err.name === "TimeoutError" ? "deadline" : "unreachable",
			});
		}
	}

	// --- Health and heartbeat ---

	private setAgentState(state: "running" | "stable"): void {
		if (this.agentapi.state === state) return;
		this.agentapi = { state };
		this.sendFrame("agent_state", { state });
	}

	private startHealthLoop(exec: ExecSpec): void {
		const timer = setInterval(() => {
			void (async () => {
				for (const name of Object.keys(exec.services)) {
					await this.probeService(exec, name, false);
				}
			})();
		}, HEALTH_INTERVAL_MS);
		this.timers.push(timer);
		// Probe immediately so readiness is not delayed by the interval.
		void (async () => {
			for (const name of Object.keys(exec.services)) {
				await this.probeService(exec, name, true);
			}
		})();
	}

	private async probeService(exec: ExecSpec, name: string, force: boolean): Promise<void> {
		const service = exec.services[name];
		if (!service) return;
		let health: "healthy" | "unhealthy" | "starting" = "starting";
		try {
			const res = await fetch(new URL(service.healthPath, service.baseUrl), {
				signal: AbortSignal.timeout(3000),
			});
			health = res.ok ? "healthy" : "unhealthy";
			if (res.ok && name === "agent") {
				const body = (await res.json().catch(() => null)) as { status?: string } | null;
				if (body?.status === "running" || body?.status === "stable") {
					this.setAgentState(body.status);
				}
			}
		} catch {
			health = this.childPhase === "running" ? "unhealthy" : "starting";
		}
		if (force || this.health.get(name) !== health) {
			this.health.set(name, health);
			this.sendFrame("service_health", { service: name, health });
		}
	}

	private startHeartbeatLoop(): void {
		const timer = setInterval(() => {
			this.sendFrame("heartbeat", {
				child: this.childPhase,
				agentapi_state: this.agentapi.state,
			});
		}, 15_000);
		this.timers.push(timer);
	}

	// --- Logs ---

	private async pumpStream(
		stream: ReadableStream<Uint8Array> | null,
		name: "stdout" | "stderr",
	): Promise<void> {
		if (!stream) return;
		await pumpLineFramedText(
			stream,
			(text) => this.emitLogText(name, text),
			name === "stdout" ? (value) => this.captureOutputs(value) : undefined,
		);
	}

	private emitLogText(stream: "stdout" | "stderr", text: string): void {
		for (const chunk of splitUtf8Chunks(text)) {
			this.sendFrame("log_chunk", {
				stream,
				content_b64: Buffer.from(chunk).toString("base64"),
				occurred_at: new Date().toISOString(),
			});
		}
	}

	private outputBuffer = "";

	private captureOutputs(value: Uint8Array): void {
		this.outputBuffer += Buffer.from(value).toString("utf8");
		const lines = this.outputBuffer.split("\n");
		this.outputBuffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("POCKETCODER_OUTPUT ")) continue;
			try {
				const parsed = JSON.parse(line.slice("POCKETCODER_OUTPUT ".length)) as {
					name?: unknown;
					value?: unknown;
				};
				if (typeof parsed.name === "string") {
					this.sendFrame("output_published", {
						name: parsed.name,
						value: parsed.value,
					});
				}
			} catch {
				this.log("ignored malformed POCKETCODER_OUTPUT line");
			}
		}
	}

	private log(message: string): void {
		this.sendFrame("log_chunk", {
			stream: "runtime",
			content_b64: Buffer.from(`${message}\n`).toString("base64"),
			occurred_at: new Date().toISOString(),
		});
	}

	// --- Exit ---

	private async flushAndClose(): Promise<void> {
		// Give queued frames a moment to flush before closing.
		await new Promise((resolve) => setTimeout(resolve, 250));
		this.shuttingDown = true;
		for (const timer of this.timers) clearInterval(timer);
		try {
			this.ws?.close(1000, "supervisor exiting");
		} catch {
			// Already closed.
		}
	}

	private exitWith(code: number): void {
		for (const timer of this.timers) clearInterval(timer);
		this.finish(code);
	}
}
