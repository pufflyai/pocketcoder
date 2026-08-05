import {
	type ExecSpec,
	ProviderBootstrapInputSchema,
	type ProviderInput,
	parseDurationMs,
	ServerFrameSchema,
} from "@pstdio/pocketcoder-contracts";
import { AgentConnection } from "./agent-connection";
import { AgentHealthMonitor } from "./agent-health";
import { AttachmentManager } from "./attachments";
import { prepareCheckpoint } from "./checkpoint-coordinator";
import { waitForPoolLease } from "./pool-lease";
import { relayProxyRequest } from "./proxy-relay";
import {
	EXIT_NETWORK_POLICY_FAILED,
	EXIT_PROTOCOL_ERROR,
	EXIT_REGISTRATION_FAILED,
	EXIT_SETUP_FAILED,
	EXIT_WRITABLE_MEMORY_FAILED,
} from "./supervisor-constants";
import { SupervisorLogs } from "./supervisor-logs";
import {
	preflightNetwork,
	probeWritableMemory,
	reportResolvedSource,
	runSetupSteps,
	startNetworkMonitor,
} from "./supervisor-setup";
import { enforcedEnvironment } from "./supervisor-utils";
import { TerminalManager } from "./terminal-manager";

export { waitForPoolLease } from "./pool-lease";
export { EXIT_NETWORK_POLICY_FAILED } from "./supervisor-constants";
export {
	enforcedEnvironment,
	isConversationControlLine,
	pumpLineFramedText,
	splitUtf8Chunks,
	verifyWritableMemoryPaths,
} from "./supervisor-utils";

// pocketcoder-agent supervise: PID 1 inside every workspace. It registers with
// pocketcoder-server over one outbound WSS connection, runs the template's
// setup commands, supervises the harness process, probes declared loopback
// services, forwards bounded logs, and answers allowlisted relay requests.

type ChildPhase = "starting" | "setup" | "running" | "exited" | "terminating";

export async function supervise(inputPath: string): Promise<number> {
	const raw = await Bun.file(inputPath).text();
	const bootstrap = ProviderBootstrapInputSchema.parse(JSON.parse(raw));
	const input: ProviderInput =
		"pool_runtime_id" in bootstrap ? await waitForPoolLease(bootstrap) : bootstrap;
	const supervisor = new Supervisor(input);
	return await supervisor.run();
}

class Supervisor {
	private readonly input: ProviderInput;
	private readonly connection: AgentConnection;
	private readonly logs: SupervisorLogs;
	private readonly healthMonitor: AgentHealthMonitor;
	private readonly attachments: AttachmentManager;
	private readonly terminals: TerminalManager;
	private exec: ExecSpec | null = null;
	private child: ReturnType<typeof Bun.spawn> | null = null;
	private childPhase: ChildPhase = "starting";
	private childExit: number | null = null;
	private shuttingDown = false;
	private quiescing = false;
	private readonly done: Promise<number>;
	private finish!: (code: number) => void;
	private timers: Array<ReturnType<typeof setInterval>> = [];
	private execReady!: () => void;
	private readonly execReadyPromise: Promise<void>;

	constructor(input: ProviderInput) {
		this.input = input;
		this.connection = new AgentConnection(input, {
			services: () => (this.exec ? Object.keys(this.exec.services) : []),
			onMessage: (raw) => void this.handleMessage(raw),
			onRegistrationFailure: () => this.exitWith(EXIT_REGISTRATION_FAILED),
			isStopped: () => this.shuttingDown || this.childExit !== null,
		});
		this.logs = new SupervisorLogs(this.sendFrame.bind(this));
		this.terminals = new TerminalManager(() => this.exec, this.sendFrame.bind(this));
		this.attachments = new AttachmentManager(this.sendFrame.bind(this));
		this.healthMonitor = new AgentHealthMonitor({
			exec: () => this.exec,
			childPhase: () => this.childPhase,
			send: this.sendFrame.bind(this),
			log: this.logs.log.bind(this.logs),
		});
		this.done = new Promise((resolve) => {
			this.finish = resolve;
		});
		this.execReadyPromise = new Promise((resolve) => {
			this.execReady = resolve;
		});
	}

	async run(): Promise<number> {
		const shutdown = () => {
			void this.gracefulShutdown();
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
		try {
			return await this.runWorkspace();
		} finally {
			process.off("SIGINT", shutdown);
			process.off("SIGTERM", shutdown);
		}
	}

	private async runWorkspace(): Promise<number> {
		this.connection.connect();
		// Wait until the server delivered the exec spec, then run setup and
		// start the harness exactly once. Registration failure resolves
		// `done` first, so a rejected connection cannot hang the supervisor.
		const raced = await Promise.race([this.execReadyPromise.then(() => null), this.done]);
		if (raced !== null) return raced;
		const exec = this.exec;
		if (!exec) return EXIT_PROTOCOL_ERROR;
		if (!(await preflightNetwork(exec, this.sendFrame.bind(this), this.flushAndClose.bind(this)))) {
			return EXIT_NETWORK_POLICY_FAILED;
		}

		if (exec.launch_mode === "restore") {
			this.sendFrame("restore_status", {
				phase: "validating",
				capability: exec.persistence.conversation_restore,
			});
		}
		const memoryOk = await probeWritableMemory(exec, this.logs.log.bind(this.logs));
		if (!memoryOk) {
			this.failedSetupStep = "writable-memory-preflight";
			this.sendFrame("process_state", {
				phase: "exited",
				exit_code: EXIT_WRITABLE_MEMORY_FAILED,
				setup_step: this.failedSetupStep ?? "writable-memory-preflight",
			});
			await this.flushAndClose();
			return EXIT_WRITABLE_MEMORY_FAILED;
		}
		this.failedSetupStep = await runSetupSteps(exec, {
			send: this.sendFrame.bind(this),
			log: this.logs.log.bind(this.logs),
			pump: this.logs.pump.bind(this.logs),
			setSetupPhase: () => {
				this.childPhase = "setup";
			},
		});
		if (this.failedSetupStep) {
			this.sendFrame("process_state", {
				phase: "exited",
				exit_code: EXIT_SETUP_FAILED,
				setup_step: this.failedSetupStep ?? "setup",
			});
			await this.flushAndClose();
			return EXIT_SETUP_FAILED;
		}
		await reportResolvedSource(exec, this.sendFrame.bind(this), this.logs.log.bind(this.logs));
		if (exec.launch_mode === "restore") {
			this.sendFrame("restore_status", {
				phase: "ready",
				capability: exec.persistence.conversation_restore,
			});
		}
		this.startHarness(exec);
		this.timers.push(this.healthMonitor.start(exec));
		const networkMonitor = startNetworkMonitor(exec, this.sendFrame.bind(this), (code) => {
			this.child?.kill("SIGKILL");
			this.exitWith(code);
		});
		if (networkMonitor) this.timers.push(networkMonitor);
		this.timers.push(this.healthMonitor.startHeartbeat());
		return await this.done;
	}

	// --- Connection ---

	private sendFrame(type: Parameters<AgentConnection["send"]>[0], payload: unknown) {
		return this.connection.send(type, payload);
	}

	private async handleMessage(raw: string): Promise<void> {
		const parsed = ServerFrameSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) return;
		const frame = parsed.data;
		switch (frame.type) {
			case "registered_ack": {
				if (frame.payload.reconnect_credential) {
					this.connection.setReconnectCredential(frame.payload.reconnect_credential);
				}
				if (this.healthMonitor.state !== "unknown") {
					this.sendFrame("agent_state", { state: this.healthMonitor.state });
				}
				if (!this.exec) {
					this.exec = frame.payload.exec;
					this.execReady();
					void this.attachments.cleanupStartup().catch(() => {});
				}
				return;
			}
			case "proxy_request":
				await relayProxyRequest(frame.payload, {
					exec: () => this.exec,
					isQuiescing: () => this.quiescing,
					send: this.sendFrame.bind(this),
					onAgentTurn: () => this.healthMonitor.setAgentState("running"),
					probeAgent: (exec) => void this.healthMonitor.probeService(exec, "agent", true),
				});
				return;
			case "terminal_open":
				this.terminals.open(frame.payload);
				return;
			case "terminal_input":
				this.terminals.input(frame.payload);
				return;
			case "terminal_resize":
				this.terminals.resize(frame.payload);
				return;
			case "terminal_close":
				await this.terminals.close(frame.payload);
				return;
			case "signal": {
				this.forwardSignal(frame.payload.signal === "KILL" ? "SIGKILL" : "SIGTERM");
				this.sendFrame("termination_ack", { phase: "term_sent" });
				return;
			}
			case "health_probe": {
				const exec = this.exec;
				if (exec) await this.healthMonitor.probeService(exec, frame.payload.service, true);
				return;
			}
			case "shutdown": {
				await this.gracefulShutdown();
				return;
			}
			case "attachment_start":
				await this.attachments.handleStart(frame.payload);
				return;
			case "attachment_chunk":
				await this.attachments.handleChunk(frame.payload);
				return;
			case "attachment_finish":
				await this.attachments.handleFinish(frame.payload);
				return;
			case "attachment_abort":
				await this.attachments.handleAbort(frame.payload);
				return;
			case "attachment_resolve":
				await this.attachments.handleResolve(frame.payload);
				return;
			case "prepare_checkpoint": {
				await prepareCheckpoint(frame.payload.operation_id, frame.payload.deadline_ms, {
					exec: () => this.exec,
					send: this.sendFrame.bind(this),
					pump: this.logs.pump.bind(this.logs),
					readAgentApiStatus: this.healthMonitor.readAgentApiStatus.bind(this.healthMonitor),
					syncAgentApiMessages: this.healthMonitor.syncMessages.bind(this.healthMonitor),
					child: () => this.child,
					childExited: () => this.childExit !== null,
					closeTerminals: () => this.terminals.closeAll("checkpoint"),
					setQuiescing: (value) => {
						this.quiescing = value;
					},
				});
				return;
			}
		}
	}

	// --- Setup commands ---

	private failedSetupStep: string | null = null;

	// --- Harness ---

	private startHarness(exec: ExecSpec): void {
		this.childPhase = "running";
		this.sendFrame("process_state", { phase: "running" });
		// The caller's opaque launch input reaches the harness in memory
		// only; it is never written to the workspace filesystem by the
		// supervisor and the server erases its copy at readiness.
		const child = Bun.spawn(exec.harness.command, {
			cwd: exec.harness.cwd ?? "/",
			env: enforcedEnvironment(exec, {
				...exec.harness.env,
				POCKETCODER_LAUNCH_MODE: exec.launch_mode,
				...(exec.source ? { POCKETCODER_SOURCE: JSON.stringify(exec.source) } : {}),
				...(exec.restore ? { POCKETCODER_RESTORE: JSON.stringify(exec.restore) } : {}),
				...(this.input.launch_input
					? { POCKETCODER_LAUNCH_INPUT: JSON.stringify(this.input.launch_input) }
					: {}),
			}),
			stdout: "pipe",
			stderr: "pipe",
		});
		this.child = child;
		const pumps = [this.logs.pump(child.stdout, "stdout"), this.logs.pump(child.stderr, "stderr")];
		void child.exited.then(async (code) => {
			this.childPhase = "exited";
			this.childExit = code;
			await Promise.all(pumps);
			this.sendFrame("process_state", { phase: "exited", exit_code: code });
			if (this.quiescing) return;
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
		await this.terminals.closeAll("workspace_ended");
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

	// --- Exit ---

	private async flushAndClose(): Promise<void> {
		await this.terminals.closeAll("workspace_ended");
		// Give queued frames a moment to flush before closing.
		await new Promise((resolve) => setTimeout(resolve, 250));
		this.shuttingDown = true;
		for (const timer of this.timers) clearInterval(timer);
		try {
			this.connection.close();
		} catch {
			// Already closed.
		}
	}

	private exitWith(code: number): void {
		for (const timer of this.timers) clearInterval(timer);
		this.finish(code);
	}
}
