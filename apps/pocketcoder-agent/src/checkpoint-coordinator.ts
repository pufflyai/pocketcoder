import type { AgentFrame, ExecSpec } from "@pstdio/pocketcoder-contracts";
import { enforcedEnvironment } from "./supervisor-utils";

type SendFrame = (type: AgentFrame["type"], payload: unknown) => boolean;

export async function prepareCheckpoint(
	operationId: string,
	deadlineMs: number,
	callbacks: {
		exec(): ExecSpec | null;
		send: SendFrame;
		pump(stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr"): Promise<void>;
		readAgentApiStatus(timeoutMs: number): Promise<"running" | "stable" | null>;
		syncAgentApiMessages(): Promise<void>;
		child(): { kill(signal: "SIGTERM" | "SIGKILL"): void; exited: Promise<number> } | null;
		childExited(): boolean;
		setQuiescing(value: boolean): void;
	},
) {
	const exec = callbacks.exec();
	if (exec?.agentapi_native) {
		await prepareAgentApiCheckpoint(operationId, deadlineMs, callbacks);
		return;
	}
	const hook = exec?.checkpoint_hook;
	callbacks.send("checkpoint_status", { operation_id: operationId, phase: "quiescing" });
	if (!exec || !hook) {
		callbacks.send("checkpoint_status", {
			operation_id: operationId,
			phase: "failed",
			detail: "template has no checkpoint hook",
		});
		return;
	}
	try {
		const proc = Bun.spawn(hook.command, {
			cwd: hook.cwd ?? exec.harness.cwd ?? "/",
			env: enforcedEnvironment(exec, {
				...hook.env,
				POCKETCODER_CHECKPOINT_OPERATION: operationId,
			}),
			stdout: "pipe",
			stderr: "pipe",
		});
		const pumps = [callbacks.pump(proc.stdout, "stdout"), callbacks.pump(proc.stderr, "stderr")];
		const timeout = setTimeout(
			() => proc.kill("SIGKILL"),
			Math.min(deadlineMs, hook.timeout_seconds * 1000),
		);
		const code = await proc.exited;
		clearTimeout(timeout);
		await Promise.all(pumps);
		callbacks.send("checkpoint_status", {
			operation_id: operationId,
			phase: code === 0 ? "quiesced" : "failed",
			...(code === 0 ? {} : { detail: `checkpoint hook exited ${code}` }),
		});
	} catch (error) {
		callbacks.send("checkpoint_status", {
			operation_id: operationId,
			phase: "failed",
			detail: error instanceof Error ? error.message.slice(0, 512) : "hook failed",
		});
	}
}

async function prepareAgentApiCheckpoint(
	operationId: string,
	deadlineMs: number,
	callbacks: Parameters<typeof prepareCheckpoint>[2],
) {
	callbacks.setQuiescing(true);
	callbacks.send("checkpoint_status", { operation_id: operationId, phase: "quiescing" });
	const deadline = Date.now() + deadlineMs;
	try {
		let stable = false;
		while (Date.now() < deadline) {
			const state = await callbacks.readAgentApiStatus(Math.min(3000, deadline - Date.now()));
			if (state === "stable") {
				stable = true;
				break;
			}
			await Bun.sleep(100);
		}
		if (!stable) throw new Error("AgentAPI did not become stable");
		await callbacks.syncAgentApiMessages();
		const child = callbacks.child();
		if (!child || callbacks.childExited()) throw new Error("AgentAPI is not running");
		child.kill("SIGTERM");
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("AgentAPI shutdown deadline exceeded");
		const code = await Promise.race([
			child.exited,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
		]);
		if (code === null) {
			child.kill("SIGKILL");
			throw new Error("AgentAPI shutdown deadline exceeded");
		}
		if (code !== 0 && code !== 143) throw new Error(`AgentAPI exited ${code}`);
		callbacks.send("checkpoint_status", { operation_id: operationId, phase: "quiesced" });
	} catch (error) {
		if (!callbacks.childExited()) callbacks.setQuiescing(false);
		callbacks.send("checkpoint_status", {
			operation_id: operationId,
			phase: "failed",
			detail: error instanceof Error ? error.message.slice(0, 512) : "quiesce failed",
		});
	}
}
