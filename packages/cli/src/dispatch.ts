import type { CommandContext, CommandHandler } from "./cli-context";
import {
	handleDatabase,
	handleKeys,
	handlePools,
	handlePrincipals,
	handleServer,
	handleTemplates,
} from "./handlers-admin";
import { handleDoctor } from "./handlers-doctor";
import { handleCheckpoints, handleStorage } from "./handlers-maintenance";
import {
	handleWorkspaceAttach,
	handleWorkspaceChat,
	handleWorkspaceCore,
	handleWorkspacePersistence,
	handleWorkspaceTerminal,
} from "./handlers-workspaces";

const handlers: CommandHandler[] = [
	handleServer,
	handleDatabase,
	handlePrincipals,
	handleKeys,
	handleTemplates,
	handlePools,
	handleWorkspaceCore,
	handleWorkspacePersistence,
	handleWorkspaceAttach,
	handleWorkspaceChat,
	handleWorkspaceTerminal,
	handleCheckpoints,
	handleStorage,
	handleDoctor,
];

export async function dispatchCommand(context: CommandContext) {
	for (const handler of handlers) if (await handler(context)) return true;
	return false;
}
