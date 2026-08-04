import { randomUUID } from "node:crypto";
import {
	type PocketCoderClient,
	TERMINAL_WORKSPACE_STATES,
	type WorkspaceSummary,
} from "@pstdio/pocketcoder-client";
import type { CliFail, ChatFlags as CreateFlags } from "./workspace-chat";

export interface WorkspaceCreateDeps {
	client: PocketCoderClient;
	fail: CliFail;
}

function need(flags: CreateFlags, key: string, fail: CliFail): string {
	const value = flags[key];
	if (typeof value !== "string" || value === "") fail(`missing required flag --${key}`);
	return value;
}

function parseLaunchInput(flags: CreateFlags, fail: CliFail): Record<string, unknown> | undefined {
	if (typeof flags.input !== "string") return undefined;
	try {
		return JSON.parse(flags.input) as Record<string, unknown>;
	} catch {
		fail("--input must be a JSON object");
	}
}

function waitTimeout(flags: CreateFlags, fail: CliFail): number {
	const raw = flags["wait-timeout-seconds"];
	const value = typeof raw === "number" ? raw : raw === undefined ? 300 : Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 1800) {
		fail("--wait-timeout-seconds must be an integer from 1 to 1800");
	}
	return value;
}

function failureMessage(workspace: WorkspaceSummary) {
	const reason = workspace.reason_code ?? workspace.failure?.reason_code ?? "no reason";
	const tail = workspace.failure?.log_tail.trim();
	return [
		`workspace ${workspace.id} reached ${workspace.state} (${reason})`,
		...(tail ? [`failure log:\n${tail}`] : []),
	].join("\n");
}

async function waitForReady(
	initial: WorkspaceSummary,
	flags: CreateFlags,
	{ client, fail }: WorkspaceCreateDeps,
) {
	const timeoutSeconds = waitTimeout(flags, fail);
	const deadline = Date.now() + timeoutSeconds * 1000;
	let workspace = initial;
	let interrupted = false;
	const interrupt = () => {
		interrupted = true;
	};
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	try {
		while (workspace.state !== "ready") {
			if (TERMINAL_WORKSPACE_STATES.has(workspace.state)) fail(failureMessage(workspace));
			if (interrupted) {
				if (flags["cancel-on-exit"] === true) await client.workspaces.cancel(workspace.id);
				console.error(
					`pcd: interrupted while waiting for workspace ${workspace.id}${flags["cancel-on-exit"] === true ? " (canceled)" : " (left running)"}`,
				);
				process.exit(130);
			}
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				fail(`workspace ${workspace.id} did not become ready within ${timeoutSeconds} seconds`);
			}
			const change = await client.workspaces.change(
				workspace.id,
				workspace.change_cursor,
				Math.max(0, Math.min(30, Math.ceil(remainingMs / 1000))),
			);
			workspace = change.workspace;
		}
		return workspace;
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
	}
}

export async function createWorkspace(flags: CreateFlags, deps: WorkspaceCreateDeps) {
	const template = need(flags, "template", deps.fail);
	const externalId =
		typeof flags["external-id"] === "string" ? flags["external-id"] : `pcd-${randomUUID()}`;
	const launchInput = parseLaunchInput(flags, deps.fail);
	const created = await deps.client.workspaces.create({
		externalId,
		templateName: template,
		...(typeof flags.version === "string" ? { templateVersion: flags.version } : {}),
		...(launchInput ? { launchInput } : {}),
		...(typeof flags.source === "string"
			? {
					source: {
						kind: "git",
						repository: flags.source,
						revision: typeof flags.revision === "string" ? flags.revision : "main",
					},
				}
			: {}),
	});
	if (flags.wait !== true) {
		console.log(JSON.stringify(created, null, 2));
		return;
	}
	if (flags.json !== true)
		console.log(`workspace ${created.id} ${created.state}; waiting for ready`);
	const ready = await waitForReady(created, flags, deps);
	if (flags.json === true) console.log(JSON.stringify(ready, null, 2));
	else console.log(`workspace ${ready.id} ready`);
}
