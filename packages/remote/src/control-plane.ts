import {
	ConversationGoneError,
	type ConversationMessage,
	PocketCoderClient,
	PocketCoderError,
	TERMINAL_WORKSPACE_STATES,
	type WorkspaceSummary,
	WorkspaceTerminalError,
} from "@pstdio/pocketcoder-client";

export {
	ConversationGoneError,
	type ConversationMessage,
	PocketCoderError as ControlPlaneError,
	TERMINAL_WORKSPACE_STATES,
	type WorkspaceSummary,
	WorkspaceTerminalError,
};

export interface ControlPlaneConfig {
	baseUrl: string;
	key: string;
}

/** @internal The remote UI keeps its historical config vocabulary at its boundary. */
export class ControlPlaneClient extends PocketCoderClient {
	constructor(config: ControlPlaneConfig, fetchImpl: typeof fetch = fetch) {
		super({ baseUrl: config.baseUrl, apiKey: config.key }, fetchImpl);
	}
}
