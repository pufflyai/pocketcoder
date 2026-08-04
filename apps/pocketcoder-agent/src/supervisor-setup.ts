import type { AgentFrame, ExecSpec } from "@pstdio/pocketcoder-contracts";
import { EXIT_NETWORK_POLICY_FAILED } from "./supervisor-constants";
import { enforcedEnvironment, verifyWritableMemoryPaths } from "./supervisor-utils";

type SendFrame = (type: AgentFrame["type"], payload: unknown) => boolean;

export async function preflightNetwork(
	exec: ExecSpec,
	send: SendFrame,
	flushAndClose: () => Promise<void>,
) {
	if (exec.network.mode !== "restricted") return true;
	send("network_state", { state: "starting" });
	try {
		const response = await fetch(exec.network.health_url, { signal: AbortSignal.timeout(3000) });
		if (!response.ok) throw new Error(`firewall health returned ${response.status}`);
		send("network_state", { state: "ready" });
		return true;
	} catch (error) {
		send("network_state", {
			state: "degraded",
			detail: error instanceof Error ? error.message.slice(0, 512) : "firewall unavailable",
		});
		await flushAndClose();
		return false;
	}
}

export function startNetworkMonitor(
	exec: ExecSpec,
	send: SendFrame,
	terminate: (code: number) => void,
) {
	if (exec.network.mode !== "restricted") return null;
	const network = exec.network;
	let failures = 0;
	return setInterval(() => {
		void (async () => {
			try {
				const response = await fetch(network.health_url, { signal: AbortSignal.timeout(3000) });
				if (!response.ok) throw new Error(`firewall health returned ${response.status}`);
				failures = 0;
			} catch {
				failures += 1;
				if (failures < 3) return;
				send("network_state", {
					state: "degraded",
					detail: "firewall health failed three consecutive probes",
				});
				terminate(EXIT_NETWORK_POLICY_FAILED);
			}
		})();
	}, 5000);
}

export async function probeWritableMemory(exec: ExecSpec, log: (message: string) => void) {
	try {
		await verifyWritableMemoryPaths(exec.security.writable_memory_paths);
		return true;
	} catch (error) {
		log(error instanceof Error ? error.message : "writable memory preflight failed");
		return false;
	}
}

export async function runSetupSteps(
	exec: ExecSpec,
	callbacks: {
		send: SendFrame;
		log(message: string): void;
		pump(stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr"): Promise<void>;
		setSetupPhase(): void;
	},
) {
	for (const step of exec.setup) {
		callbacks.setSetupPhase();
		callbacks.send("process_state", { phase: "setup", setup_step: step.name });
		const proc = Bun.spawn(step.command, {
			cwd: step.cwd ?? exec.harness.cwd ?? "/",
			env: enforcedEnvironment(exec, {
				...step.env,
				POCKETCODER_LAUNCH_MODE: exec.launch_mode,
				...(exec.source ? { POCKETCODER_SOURCE: JSON.stringify(exec.source) } : {}),
				...(exec.restore ? { POCKETCODER_RESTORE: JSON.stringify(exec.restore) } : {}),
			}),
			stdout: "pipe",
			stderr: "pipe",
		});
		const pumps = [callbacks.pump(proc.stdout, "stdout"), callbacks.pump(proc.stderr, "stderr")];
		const timeout = setTimeout(() => proc.kill("SIGKILL"), step.timeoutSeconds * 1000);
		const code = await proc.exited;
		clearTimeout(timeout);
		await Promise.all(pumps);
		if (code === 0) continue;
		callbacks.log(`setup step ${step.name} failed with exit code ${code}`);
		return step.name;
	}
	return null;
}

export async function reportResolvedSource(
	exec: ExecSpec,
	send: SendFrame,
	log: (message: string) => void,
) {
	if (!exec.source) return;
	try {
		const proc = Bun.spawn(
			["git", "-C", exec.source.destination, "rev-parse", "--verify", "HEAD"],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		const commit = stdout.trim().toLowerCase();
		if (code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
			throw new Error("git did not return an immutable commit");
		}
		send("source_resolved", {
			repository: exec.source.repository,
			requested_revision: exec.source.revision,
			resolved_commit: commit,
		});
	} catch (error) {
		log(`source resolution failed: ${error instanceof Error ? error.message : "unknown error"}`);
	}
}
