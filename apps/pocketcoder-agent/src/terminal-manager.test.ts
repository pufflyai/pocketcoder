import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AgentFrame, ExecSpec } from "@pstdio/pocketcoder-contracts";
import { TerminalManager } from "./terminal-manager";

function exec(command: string[]): ExecSpec {
	return {
		agentapi_native: false,
		setup: [],
		harness: { command: ["/bin/true"], env: {} },
		env: {},
		services: {},
		timeouts: {
			start: "2m",
			maxAge: "2h",
			idle: "20m",
			disconnectGrace: "5m",
			terminateGrace: "15s",
		},
		security: { writable_memory_paths: [] },
		network: { mode: "unrestricted" },
		launch_mode: "create",
		source: null,
		restore: null,
		persistence: { mounts: [], conversation_restore: "filesystem_only" },
		checkpoint_hook: null,
		outputs: {},
		terminal: {
			command,
			env: {},
			max_sessions: 2,
			idle_timeout_seconds: 60,
			replay_buffer_bytes: 65_536,
		},
	};
}

async function waitFor(check: () => boolean) {
	const deadline = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for terminal frame");
		await Bun.sleep(2);
	}
}

describe("TerminalManager", () => {
	test("runs only the template command under a PTY and reports its exit code", async () => {
		const frames: Array<{ type: AgentFrame["type"]; payload: Record<string, unknown> }> = [];
		const manager = new TerminalManager(
			() => exec(["/bin/sh", "-c", "printf terminal-ok; exit 7"]),
			(type, payload) => {
				frames.push({ type, payload: payload as Record<string, unknown> });
				return true;
			},
		);
		const sessionId = randomUUID();

		manager.open({ session_id: sessionId, rows: 24, cols: 80, reattach: false });
		await waitFor(() => frames.some((frame) => frame.type === "terminal_closed"));

		const output = frames
			.filter((frame) => frame.type === "terminal_output")
			.map((frame) => Buffer.from(String(frame.payload.data_b64), "base64").toString())
			.join("");
		expect(output).toContain("terminal-ok");
		expect(frames.at(-1)).toMatchObject({
			type: "terminal_closed",
			payload: { session_id: sessionId, reason: "exit", exit_code: 7 },
		});
	});

	test("replays buffered output when the same live session reattaches", async () => {
		const frames: Array<{ type: AgentFrame["type"]; payload: Record<string, unknown> }> = [];
		const current = exec(["/bin/sh"]);
		const manager = new TerminalManager(
			() => current,
			(type, payload) => {
				frames.push({ type, payload: payload as Record<string, unknown> });
				return true;
			},
		);
		const sessionId = randomUUID();
		manager.open({ session_id: sessionId, rows: 24, cols: 80, reattach: false });
		manager.input({
			session_id: sessionId,
			data_b64: Buffer.from("printf replay-ok\\r").toString("base64"),
		});
		await waitFor(() =>
			frames.some(
				(frame) =>
					frame.type === "terminal_output" &&
					Buffer.from(String(frame.payload.data_b64), "base64").toString().includes("replay-ok"),
			),
		);
		frames.length = 0;

		manager.open({ session_id: sessionId, rows: 40, cols: 120, reattach: true });

		expect(frames[0]).toMatchObject({
			type: "terminal_opened",
			payload: { session_id: sessionId },
		});
		expect(Buffer.from(String(frames[0]?.payload.replay_b64), "base64").toString()).toContain(
			"replay-ok",
		);
		await manager.closeAll("workspace_ended");
	});

	test("refuses opens when the template did not declare a terminal", () => {
		const frames: Array<{ type: AgentFrame["type"]; payload: Record<string, unknown> }> = [];
		const withoutTerminal = { ...exec(["/bin/sh"]), terminal: null };
		const manager = new TerminalManager(
			() => withoutTerminal,
			(type, payload) => {
				frames.push({ type, payload: payload as Record<string, unknown> });
				return true;
			},
		);
		const sessionId = randomUUID();

		manager.open({ session_id: sessionId, rows: 24, cols: 80, reattach: false });

		expect(frames).toEqual([
			expect.objectContaining({
				type: "terminal_closed",
				payload: expect.objectContaining({ session_id: sessionId, reason: "error" }),
			}),
		]);
	});

	test("reports a terminal error when the template command cannot start", () => {
		const frames: Array<{ type: AgentFrame["type"]; payload: Record<string, unknown> }> = [];
		const manager = new TerminalManager(
			() => exec(["/definitely/missing/pocketcoder-terminal"]),
			(type, payload) => {
				frames.push({ type, payload: payload as Record<string, unknown> });
				return true;
			},
		);
		const sessionId = randomUUID();

		manager.open({ session_id: sessionId, rows: 24, cols: 80, reattach: false });

		expect(frames).toEqual([
			expect.objectContaining({
				type: "terminal_closed",
				payload: expect.objectContaining({ session_id: sessionId, reason: "error" }),
			}),
		]);
	});

	test("closes a session after its terminal input idle timeout", async () => {
		const frames: Array<{ type: AgentFrame["type"]; payload: Record<string, unknown> }> = [];
		const current = exec(["/bin/sh"]);
		if (!current.terminal) throw new Error("expected terminal config");
		current.terminal.idle_timeout_seconds = 0.01;
		const manager = new TerminalManager(
			() => current,
			(type, payload) => {
				frames.push({ type, payload: payload as Record<string, unknown> });
				return true;
			},
		);
		manager.open({ session_id: randomUUID(), rows: 24, cols: 80, reattach: false });

		await waitFor(() => frames.some((frame) => frame.type === "terminal_closed"));

		expect(frames.at(-1)).toMatchObject({
			type: "terminal_closed",
			payload: { reason: "idle" },
		});
	});
});
