import type { ControlPlaneClient, WorkspaceSummary } from "./control-plane";
import { TERMINAL_WORKSPACE_STATES } from "./control-plane";

export const STATUS_KEY = "pocketcoder";

export interface StatusUi {
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface StatusPollerOptions {
	waitSeconds?: number;
	delay?: (ms: number) => Promise<void>;
}

export function statusText(
	workspace: Pick<WorkspaceSummary, "id" | "state" | "agent_state">,
): string {
	return `ws ${workspace.id.slice(0, 8)} · ${workspace.state}/${workspace.agent_state}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keeps the status bar in sync with the workspace via the durable change
 * cursor. Paused during turns so RemoteAgentClient.send() is the only
 * consumer of the change feed while the agent is working.
 */
export class StatusPoller {
	private readonly controlPlane: ControlPlaneClient;
	private readonly workspaceId: string;
	private readonly ui: StatusUi;
	private readonly waitSeconds: number;
	private readonly delay: (ms: number) => Promise<void>;
	private cursor: number;
	private paused = false;
	private stopped = false;
	private wake: (() => void) | undefined;
	private controller: AbortController | undefined;
	private loop: Promise<void> | undefined;
	private lastText: string | undefined;

	constructor(
		controlPlane: ControlPlaneClient,
		workspace: Pick<WorkspaceSummary, "id" | "change_cursor">,
		ui: StatusUi,
		options: StatusPollerOptions = {},
	) {
		this.controlPlane = controlPlane;
		this.workspaceId = workspace.id;
		this.cursor = workspace.change_cursor ?? 0;
		this.ui = ui;
		this.waitSeconds = options.waitSeconds ?? 30;
		this.delay = options.delay ?? sleep;
	}

	start(): void {
		if (!this.loop) this.loop = this.run();
	}

	pause(): void {
		this.paused = true;
		this.controller?.abort();
	}

	resume(): void {
		if (!this.paused) return;
		this.paused = false;
		this.wake?.();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.controller?.abort();
		this.wake?.();
		await this.loop;
		this.ui.setStatus(STATUS_KEY, undefined);
	}

	private async run(): Promise<void> {
		let backoffMs = 1_000;
		while (!this.stopped) {
			if (this.paused) {
				await new Promise<void>((resolve) => {
					this.wake = resolve;
				});
				continue;
			}
			this.controller = new AbortController();
			try {
				const change = await this.controlPlane.workspaces.change(
					this.workspaceId,
					this.cursor,
					this.waitSeconds,
					{ signal: this.controller.signal },
				);
				backoffMs = 1_000;
				this.cursor = change.cursor;
				this.lastText = statusText(change.workspace);
				this.ui.setStatus(STATUS_KEY, this.lastText);
				if (TERMINAL_WORKSPACE_STATES.has(change.workspace.state)) {
					this.ui.notify(
						`workspace ${change.workspace.id.slice(0, 8)} is ${change.workspace.state}`,
						change.workspace.state === "succeeded" ? "info" : "warning",
					);
					return;
				}
			} catch {
				if (this.stopped || this.paused) continue;
				this.ui.setStatus(
					STATUS_KEY,
					`${this.lastText ?? `ws ${this.workspaceId.slice(0, 8)}`} · reconnecting`,
				);
				await this.delay(backoffMs);
				backoffMs = Math.min(backoffMs * 2, 30_000);
			}
		}
	}
}
