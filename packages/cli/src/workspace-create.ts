import { randomUUID } from "node:crypto";
import type { ApiRequest, CliFail, ChatFlags as CreateFlags } from "./workspace-chat";

export interface WorkspaceCreateDeps {
	api: ApiRequest;
	fail: CliFail;
}

interface CliWorkspaceResource {
	id: string;
	state: string;
	reason_code?: string | null;
	change_cursor?: number;
	failure?: {
		reason_code?: string;
		log_tail?: string;
		log_tail_truncated?: boolean;
	} | null;
}

const TERMINAL_WORKSPACE_STATES = new Set([
	"succeeded",
	"failed",
	"canceled",
	"expired",
	"preserved",
]);

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

function failureMessage(workspace: CliWorkspaceResource): string {
	const reason = workspace.reason_code ?? workspace.failure?.reason_code ?? "no reason";
	const tail = workspace.failure?.log_tail?.trim();
	return [
		`workspace ${workspace.id} reached ${workspace.state} (${reason})`,
		...(tail ? [`failure log:\n${tail}`] : []),
	].join("\n");
}

async function cancel(id: string, api: ApiRequest): Promise<void> {
	await api(`/v1/workspaces/${id}/cancel`, { method: "POST" }).catch(() => {});
}

async function readChange(
	workspace: CliWorkspaceResource,
	waitSeconds: number,
	{ api, fail }: WorkspaceCreateDeps,
): Promise<CliWorkspaceResource> {
	const after = workspace.change_cursor ?? 0;
	const response = await api(
		`/v1/workspaces/${workspace.id}/changes?after=${after}&wait=${waitSeconds}`,
	);
	const body = (await response.json()) as {
		workspace?: CliWorkspaceResource;
		error?: unknown;
	};
	if (!response.ok) fail(`workspace wait failed (${response.status}): ${JSON.stringify(body)}`);
	const changed = body.workspace;
	if (!changed) throw new Error("workspace wait returned no workspace resource");
	return changed;
}

async function waitForReady(
	initial: CliWorkspaceResource,
	flags: CreateFlags,
	deps: WorkspaceCreateDeps,
): Promise<CliWorkspaceResource> {
	const timeoutSeconds = waitTimeout(flags, deps.fail);
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
			if (TERMINAL_WORKSPACE_STATES.has(workspace.state)) {
				deps.fail(failureMessage(workspace));
			}
			if (interrupted) {
				if (flags["cancel-on-exit"] === true) await cancel(workspace.id, deps.api);
				console.error(
					`pcd: interrupted while waiting for workspace ${workspace.id}${flags["cancel-on-exit"] === true ? " (canceled)" : " (left running)"}`,
				);
				process.exit(130);
			}
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				deps.fail(
					`workspace ${workspace.id} did not become ready within ${timeoutSeconds} seconds`,
				);
			}
			workspace = await readChange(
				workspace,
				Math.max(0, Math.min(30, Math.ceil(remainingMs / 1000))),
				deps,
			);
		}
		return workspace;
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
	}
}

export async function createWorkspace(
	flags: CreateFlags,
	deps: WorkspaceCreateDeps,
): Promise<void> {
	const template = need(flags, "template", deps.fail);
	const externalId =
		typeof flags["external-id"] === "string" ? flags["external-id"] : `pcd-${randomUUID()}`;
	const launchInput = parseLaunchInput(flags, deps.fail);
	const response = await deps.api("/v1/workspaces", {
		method: "POST",
		headers: { "idempotency-key": externalId },
		body: JSON.stringify({
			external_id: externalId,
			template: {
				name: template,
				...(typeof flags.version === "string" ? { version: flags.version } : {}),
			},
			...(launchInput ? { launch_input: launchInput } : {}),
			...(typeof flags.source === "string"
				? {
						source: {
							kind: "git",
							repository: flags.source,
							revision: typeof flags.revision === "string" ? flags.revision : "main",
						},
					}
				: {}),
		}),
	});
	const created = (await response.json()) as CliWorkspaceResource;
	if (!response.ok) {
		console.log(JSON.stringify(created, null, 2));
		process.exit(1);
	}
	if (flags.wait !== true) {
		console.log(JSON.stringify(created, null, 2));
		return;
	}
	if (flags.json !== true) {
		console.log(`workspace ${created.id} ${created.state}; waiting for ready`);
	}
	const ready = await waitForReady(created, flags, deps);
	if (flags.json === true) console.log(JSON.stringify(ready, null, 2));
	else console.log(`workspace ${ready.id} ready`);
}
