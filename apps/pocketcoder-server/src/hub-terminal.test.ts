import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TerminalClosed } from "@pstdio/pocketcoder-contracts";
import type { WSContext } from "hono/ws";
import { Hub } from "./hub";
import type { TerminalBridgeClosed } from "./terminal-bridge";

function socket(sent: string[]) {
	return {
		send(data: string) {
			sent.push(data);
		},
		close() {},
	} as unknown as WSContext;
}

describe("terminal bridge", () => {
	test("forwards terminal traffic and reports audited byte counts on close", () => {
		const agentFrames: string[] = [];
		const clientFrames: string[] = [];
		const closed: Array<TerminalClosed & { bytesIn: number; bytesOut: number }> = [];
		const activity: string[] = [];
		const hub = new Hub({
			onTerminalInput: (workspaceId) => {
				activity.push(workspaceId);
			},
			onTerminalClosed: (event) => {
				closed.push(event);
			},
		});
		const workspaceId = randomUUID();
		const sessionId = randomUUID();
		const connection = hub.attach(workspaceId, randomUUID(), 1, socket(agentFrames), 4);
		connection.registered = true;
		const client = socket(clientFrames);

		hub.openTerminal(workspaceId, sessionId, client, false, 24, 80);
		hub.terminalOpened(connection, { session_id: sessionId });
		hub.terminalClientMessage(workspaceId, sessionId, client, {
			type: "input",
			data_b64: Buffer.from("echo").toString("base64"),
		});
		hub.terminalOutput(connection, {
			session_id: sessionId,
			data_b64: Buffer.from("result!!").toString("base64"),
		});
		hub.terminalClosed(connection, {
			session_id: sessionId,
			reason: "exit",
			exit_code: 7,
		});

		expect(agentFrames.map((value) => JSON.parse(value).type)).toEqual([
			"terminal_open",
			"terminal_input",
		]);
		expect(clientFrames.map((value) => JSON.parse(value).type)).toEqual([
			"opened",
			"output",
			"closed",
		]);
		expect(activity).toEqual([workspaceId]);
		expect(closed).toEqual([
			expect.objectContaining({
				session_id: sessionId,
				reason: "exit",
				exit_code: 7,
				bytesIn: 4,
				bytesOut: 8,
			}),
		]);
	});

	test("keeps the client bridge across an agent reconnect and reattaches the PTY", () => {
		const firstAgentFrames: string[] = [];
		const secondAgentFrames: string[] = [];
		const clientFrames: string[] = [];
		const hub = new Hub();
		const workspaceId = randomUUID();
		const sessionId = randomUUID();
		const first = hub.attach(workspaceId, randomUUID(), 1, socket(firstAgentFrames), 4);
		first.registered = true;
		const client = socket(clientFrames);
		hub.openTerminal(workspaceId, sessionId, client, false, 24, 80);

		hub.detach(first);
		const second = hub.attach(workspaceId, randomUUID(), 2, socket(secondAgentFrames), 4);
		second.registered = true;
		hub.resumeTerminals(second);

		expect(clientFrames.map((value) => JSON.parse(value))).toEqual([
			{ type: "status", state: "reconnecting" },
			{ type: "status", state: "resumed" },
		]);
		expect(JSON.parse(secondAgentFrames[0] ?? "{}")).toMatchObject({
			type: "terminal_open",
			payload: { session_id: sessionId, reattach: true, rows: 24, cols: 80 },
		});
	});

	test("queues a new open when the agent disconnects during the client upgrade", () => {
		const agentFrames: string[] = [];
		const clientFrames: string[] = [];
		const hub = new Hub();
		const workspaceId = randomUUID();
		const sessionId = randomUUID();
		const first = hub.attach(workspaceId, randomUUID(), 1, socket([]), 4);
		first.registered = true;
		hub.detach(first);

		hub.openTerminal(workspaceId, sessionId, socket(clientFrames), false, 24, 80);
		const second = hub.attach(workspaceId, randomUUID(), 2, socket(agentFrames), 4);
		second.registered = true;
		hub.resumeTerminals(second);

		expect(clientFrames.map((value) => JSON.parse(value))).toEqual([
			{ type: "status", state: "reconnecting" },
			{ type: "status", state: "resumed" },
		]);
		expect(JSON.parse(agentFrames[0] ?? "{}")).toMatchObject({
			type: "terminal_open",
			payload: { session_id: sessionId, reattach: false },
		});
	});

	test("closes a detached session when the workspace ends without a live agent", () => {
		const closed: TerminalBridgeClosed[] = [];
		const hub = new Hub({
			onTerminalClosed: (event) => {
				closed.push(event);
			},
		});
		const workspaceId = randomUUID();
		const sessionId = randomUUID();
		const connection = hub.attach(workspaceId, randomUUID(), 1, socket([]), 4);
		connection.registered = true;
		const client = socket([]);
		hub.openTerminal(workspaceId, sessionId, client, false, 24, 80);

		hub.detachTerminalClient(workspaceId, sessionId, client);
		hub.detach(connection);
		hub.close(workspaceId);

		expect(closed).toEqual([
			expect.objectContaining({
				workspaceId,
				session_id: sessionId,
				reason: "workspace_ended",
			}),
		]);
	});

	test("reconciles a detached PTY after the agent reconnects", () => {
		const agentFrames: string[] = [];
		const hub = new Hub();
		const workspaceId = randomUUID();
		const sessionId = randomUUID();
		const first = hub.attach(workspaceId, randomUUID(), 1, socket([]), 4);
		first.registered = true;
		const client = socket([]);
		hub.openTerminal(workspaceId, sessionId, client, false, 24, 80);
		hub.detachTerminalClient(workspaceId, sessionId, client);
		hub.detach(first);
		const second = hub.attach(workspaceId, randomUUID(), 2, socket(agentFrames), 4);
		second.registered = true;

		hub.resumeTerminals(second);

		expect(JSON.parse(agentFrames[0] ?? "{}")).toMatchObject({
			type: "terminal_open",
			payload: { session_id: sessionId, reattach: true },
		});
	});
});
