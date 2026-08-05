import { randomUUID } from "node:crypto";
import { isWorkspaceState } from "@pstdio/pocketcoder-contracts";
import {
	api,
	type CommandContext,
	controlPlaneClient,
	type Flags,
	fail,
	need,
} from "./cli-context";
import { attachWorkspace, chatWorkspace } from "./workspace-chat";
import { createWorkspace } from "./workspace-create";
import { attachTerminal } from "./workspace-terminal";

export async function handleWorkspaceCore(context: CommandContext) {
	if (context.group !== "workspaces") return false;
	const commands: Record<string, () => Promise<void>> = {
		list: () => listWorkspaces(context.flags),
		create: () => createWorkspace(context.flags, { client: controlPlaneClient(), fail }),
		get: async () => {
			console.log(
				JSON.stringify(
					await controlPlaneClient().workspaces.get(need(context.flags, "id")),
					null,
					2,
				),
			);
		},
		logs: () => readLogs(context.flags),
		"network-events": () => readNetworkEvents(context.flags),
		"terminal-sessions": () => readTerminalSessions(context.flags),
		cancel: async () => {
			console.log(
				JSON.stringify(
					await controlPlaneClient().workspaces.cancel(need(context.flags, "id")),
					null,
					2,
				),
			);
		},
	};
	const command = context.action ? commands[context.action] : undefined;
	if (!command) return false;
	await command();
	return true;
}

async function listWorkspaces(flags: Flags) {
	const state = typeof flags.state === "string" ? flags.state : undefined;
	const workspaceState = state && isWorkspaceState(state) ? state : undefined;
	if (state && !workspaceState) fail(`unknown workspace state: ${state}`);
	let items = (
		await controlPlaneClient().workspaces.list({
			...(workspaceState ? { state: workspaceState } : {}),
			...(typeof flags.template === "string" ? { template: flags.template } : {}),
			...(typeof flags["external-id"] === "string" ? { externalId: flags["external-id"] } : {}),
			...(typeof flags.limit === "string" ? { limit: Number(flags.limit) } : {}),
		})
	).items;
	if (flags.active) {
		items = items.filter(
			(item) => !["succeeded", "failed", "canceled", "expired", "preserved"].includes(item.state),
		);
	}
	if (flags.json) console.log(JSON.stringify(items, null, 2));
	else {
		for (const item of items) {
			console.log(
				`${item.id}\t${item.state}${item.reason_code ? ` (${item.reason_code})` : ""}\t${item.template.name}@${item.template.version}\t${item.external_id}`,
			);
		}
		if (items.length === 0) console.log("(no workspaces)");
	}
}

async function readLogs(flags: Flags) {
	const result = await controlPlaneClient().logs.list(need(flags, "id"), pagination(flags));
	for (const line of result.items) {
		process.stdout.write(`[${line.stream} #${line.seq}] ${line.content}`);
		if (!line.content.endsWith("\n")) process.stdout.write("\n");
	}
	if (result.items.length === 0) console.log("(no logs)");
	if (result.nextCursor) console.log(`next cursor: ${result.nextCursor}`);
}

async function readNetworkEvents(flags: Flags) {
	const result = await controlPlaneClient().networkEvents.list(
		need(flags, "id"),
		pagination(flags),
	);
	for (const event of result.items) console.log(JSON.stringify(event));
	if (result.items.length === 0) console.log("(no network events)");
	if (result.nextCursor) console.log(`next cursor: ${result.nextCursor}`);
}

async function readTerminalSessions(flags: Flags) {
	const result = await controlPlaneClient().terminals.list(need(flags, "id"), pagination(flags));
	for (const session of result.items) console.log(JSON.stringify(session));
	if (result.items.length === 0) console.log("(no terminal sessions)");
	if (result.nextCursor) console.log(`next cursor: ${result.nextCursor}`);
}

function pagination(flags: Flags) {
	return {
		...(typeof flags.cursor === "string" ? { cursor: flags.cursor } : {}),
		...(typeof flags.limit === "string" ? { limit: Number(flags.limit) } : {}),
	};
}

export async function handleWorkspacePersistence({ group, action, flags }: CommandContext) {
	if (group !== "workspaces") return false;
	if (action === "preserve") {
		const id = need(flags, "id");
		const result = await controlPlaneClient().workspaces.preserve(
			id,
			{
				...(typeof flags.retention === "string" ? { retention: flags.retention } : {}),
				...(typeof flags.label === "string" ? { label: flags.label } : {}),
			},
			`preserve-${id}-${randomUUID()}`,
		);
		console.log(JSON.stringify(result, null, 2));
	} else if (action === "restore") {
		const externalId = need(flags, "external-id");
		const result = await controlPlaneClient().checkpoints.restore(
			need(flags, "checkpoint"),
			{ external_id: externalId },
			externalId,
		);
		console.log(JSON.stringify(result, null, 2));
	} else if (action === "recreate") {
		const externalId = need(flags, "external-id");
		const result = await controlPlaneClient().workspaces.recreate(
			need(flags, "id"),
			{ external_id: externalId },
			externalId,
		);
		console.log(JSON.stringify(result, null, 2));
	} else if (action === "outputs") {
		console.log(
			JSON.stringify(await controlPlaneClient().outputs.list(need(flags, "id")), null, 2),
		);
	} else return false;
	return true;
}

export async function handleWorkspaceAttach({ group, action, flags }: CommandContext) {
	if (group !== "workspaces" || action !== "attach") return false;
	await attachWorkspace(flags, { api, fail });
	return true;
}

export async function handleWorkspaceChat({ group, action, flags }: CommandContext) {
	if (group !== "workspaces" || action !== "chat") return false;
	await chatWorkspace(flags, { api, fail });
	return true;
}

export async function handleWorkspaceTerminal({ group, action, flags }: CommandContext) {
	if (group !== "workspaces" || action !== "terminal") return false;
	process.exitCode = await attachTerminal(flags, controlPlaneClient());
	return true;
}
