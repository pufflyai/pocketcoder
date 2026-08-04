import { randomUUID } from "node:crypto";
import type { ControlPlaneClient, WorkspaceSummary } from "./control-plane";
import { WorkspaceTerminalError } from "./control-plane";
import { relayTarget, type TargetRef } from "./session-target";

export interface CommandUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setWorkingMessage(message?: string): void;
}

export interface CommandContext {
	hasUI: boolean;
	ui: CommandUi;
	newSession(): Promise<{ cancelled: boolean }>;
}

export interface CommandRegistrar {
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: CommandContext) => Promise<void>;
		},
	): void;
}

export interface WorkspaceCommandDeps {
	targets: TargetRef;
	controlPlane: ControlPlaneClient;
	waitTimeoutMs?: number;
}

function workspaceLabel(workspace: WorkspaceSummary): string {
	return `${workspace.external_id} · ${workspace.template.name} · ${workspace.id.slice(0, 8)}`;
}

async function switchToWorkspace(
	deps: WorkspaceCommandDeps,
	ctx: CommandContext,
	workspaceId: string,
): Promise<void> {
	const target = deps.targets.current;
	if (target.mode === "direct") return;
	deps.targets.set(relayTarget(target.baseUrl, target.key, workspaceId));
	await ctx.newSession();
}

function requireRelayCapable(deps: WorkspaceCommandDeps, ctx: CommandContext): boolean {
	if (!ctx.hasUI) return false;
	if (deps.targets.current.mode === "direct") {
		ctx.ui.notify(
			"workspace commands need a PocketCoder server (POCKETCODER_URL), not a direct AgentAPI URL",
			"warning",
		);
		return false;
	}
	return true;
}

async function pickWorkspace(deps: WorkspaceCommandDeps, ctx: CommandContext): Promise<void> {
	const workspaces = (await deps.controlPlane.workspaces.list({ state: "ready" })).items;
	if (workspaces.length === 0) {
		ctx.ui.notify("no ready workspaces; use /workspace-create", "info");
		return;
	}
	const labels = workspaces.map(workspaceLabel);
	const selection = await ctx.ui.select("Switch workspace", labels);
	if (selection === undefined) return;
	const workspace = workspaces[labels.indexOf(selection)];
	if (workspace) await switchToWorkspace(deps, ctx, workspace.id);
}

async function createWorkspace(deps: WorkspaceCommandDeps, ctx: CommandContext): Promise<void> {
	const templates = await deps.controlPlane.templates.list();
	if (templates.length === 0) {
		ctx.ui.notify("no templates available to this key", "warning");
		return;
	}
	const labels = templates.map((template) => `${template.name}@${template.version}`);
	const selection = await ctx.ui.select("Create workspace from template", labels);
	if (selection === undefined) return;
	const template = templates[labels.indexOf(selection)];
	if (!template) return;
	const externalId =
		(await ctx.ui.input("External id", `pi-${randomUUID()}`))?.trim() || `pi-${randomUUID()}`;

	try {
		ctx.ui.setWorkingMessage(`creating workspace ${externalId}`);
		const created = await deps.controlPlane.workspaces.create({
			externalId,
			templateName: template.name,
		});
		const ready = await deps.controlPlane.workspaces.waitForReady(
			created,
			deps.waitTimeoutMs ?? 300_000,
			{
				onTick: (workspace) => ctx.ui.setWorkingMessage(`workspace ${workspace.state}`),
			},
		);
		await switchToWorkspace(deps, ctx, ready.id);
	} catch (error) {
		const message =
			error instanceof WorkspaceTerminalError
				? error.message
				: `workspace create failed: ${String(error)}`;
		ctx.ui.notify(message, "error");
	} finally {
		ctx.ui.setWorkingMessage();
	}
}

async function cancelWorkspace(deps: WorkspaceCommandDeps, ctx: CommandContext): Promise<void> {
	const target = deps.targets.current;
	if (target.mode !== "relay") {
		ctx.ui.notify("no workspace attached", "info");
		return;
	}
	const confirmed = await ctx.ui.confirm(
		"Cancel workspace",
		`Cancel workspace ${target.workspaceId}? The remote agent stops and the workspace is discarded.`,
	);
	if (!confirmed) return;
	await deps.controlPlane.workspaces.cancel(target.workspaceId);
	ctx.ui.notify(`workspace ${target.workspaceId.slice(0, 8)} canceled`, "info");
}

export function registerWorkspaceCommands(pi: CommandRegistrar, deps: WorkspaceCommandDeps): void {
	pi.registerCommand("workspace", {
		description: "Switch to another ready PocketCoder workspace",
		handler: async (_args, ctx) => {
			if (requireRelayCapable(deps, ctx)) await pickWorkspace(deps, ctx);
		},
	});
	pi.registerCommand("workspace-create", {
		description: "Create a PocketCoder workspace from a template and switch to it",
		handler: async (_args, ctx) => {
			if (requireRelayCapable(deps, ctx)) await createWorkspace(deps, ctx);
		},
	});
	pi.registerCommand("workspace-cancel", {
		description: "Cancel the current PocketCoder workspace",
		handler: async (_args, ctx) => {
			if (requireRelayCapable(deps, ctx)) await cancelWorkspace(deps, ctx);
		},
	});
}
