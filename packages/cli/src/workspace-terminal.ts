import type { PocketCoderClient, TerminalConnection } from "@pstdio/pocketcoder-sdk";
import type { Flags } from "./cli-context";
import { need } from "./cli-context";

const DETACH_ESCAPE = 0x1d;
const DETACH_KEY = "d".charCodeAt(0);

export class TerminalDetachParser {
	private pendingEscape = false;

	push(bytes: Uint8Array): { forward: Uint8Array[]; detached: boolean } {
		const forward: Uint8Array[] = [];
		let pending: number[] = [];
		const flush = () => {
			if (pending.length > 0) forward.push(Uint8Array.from(pending));
			pending = [];
		};
		for (const byte of bytes) {
			if (this.pendingEscape) {
				this.pendingEscape = false;
				if (byte === DETACH_KEY) {
					flush();
					return { forward, detached: true };
				}
				pending.push(DETACH_ESCAPE, byte);
				continue;
			}
			if (byte === DETACH_ESCAPE) {
				flush();
				this.pendingEscape = true;
				continue;
			}
			pending.push(byte);
		}
		flush();
		return { forward, detached: false };
	}
}

export async function attachTerminal(flags: Flags, client: PocketCoderClient): Promise<number> {
	const workspaceId = need(flags, "id");
	const sessionId = typeof flags.session === "string" ? flags.session : undefined;
	const terminal = client.terminals.connect(workspaceId, { sessionId });
	return await bridgeTerminal(terminal);
}

async function bridgeTerminal(terminal: TerminalConnection): Promise<number> {
	const parser = new TerminalDetachParser();
	let activeSessionId: string | undefined;
	let finished = false;
	let rawMode = false;
	const removers: Array<() => void> = [];

	const cleanup = () => {
		for (const remove of removers) remove();
		process.stdin.off("data", onInput);
		process.stdin.off("end", onInputEnd);
		process.off("SIGWINCH", onResize);
		process.off("SIGINT", onInterrupt);
		if (rawMode) process.stdin.setRawMode(false);
		process.stdin.pause();
	};
	let resolveResult!: (code: number) => void;
	const result = new Promise<number>((resolve) => {
		resolveResult = resolve;
	});
	const finish = (code: number) => {
		if (finished) return;
		finished = true;
		cleanup();
		resolveResult(code);
	};
	const detach = () => {
		process.stderr.write(
			activeSessionId
				? `Detached terminal session ${activeSessionId}\n`
				: "Detached terminal session\n",
		);
		finish(0);
		terminal.close(1000, "detached");
	};
	function onInput(value: Buffer | string) {
		const parsed = parser.push(typeof value === "string" ? Buffer.from(value) : value);
		for (const chunk of parsed.forward) terminal.sendInput(chunk);
		if (parsed.detached) detach();
	}
	function onInputEnd() {
		detach();
	}
	function onResize() {
		terminal.resize(process.stdout.rows ?? 24, process.stdout.columns ?? 80);
	}
	function onInterrupt() {
		finish(130);
		terminal.close(1000, "interrupted");
	}

	removers.push(
		terminal.onOpen(() => {
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(true);
				rawMode = true;
			}
			process.stdin.resume();
			process.stdin.on("data", onInput);
			process.stdin.on("end", onInputEnd);
			process.on("SIGWINCH", onResize);
			process.on("SIGINT", onInterrupt);
			onResize();
		}),
		terminal.onMessage((message) => {
			if (message.type === "opened") {
				activeSessionId = message.session_id;
				if (message.replay_b64) process.stdout.write(Buffer.from(message.replay_b64, "base64"));
				return;
			}
			if (message.type === "output") {
				process.stdout.write(Buffer.from(message.data_b64, "base64"));
				return;
			}
			if (message.type === "status") {
				process.stderr.write(`Terminal ${message.state}\n`);
				return;
			}
			finish(message.reason === "exit" ? (message.exit_code ?? 0) : 1);
			terminal.close();
		}),
		terminal.onClose(() => finish(1)),
		terminal.onError(() => finish(1)),
	);

	return await result;
}
