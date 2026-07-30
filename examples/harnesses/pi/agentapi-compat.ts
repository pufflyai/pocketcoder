import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// AgentAPI 0.12.2 has no Pi agent profile. Its generic PTY mode recognizes a
// ready input prompt by a trailing ">" marker, so expose one above Pi's editor.
// AgentAPI still owns the HTTP API, terminal input, output parsing, and status.
export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, context) => {
		if (!context.hasUI) return;
		context.ui.setWidget("agentapi-ready", [context.ui.theme.fg("dim", ">")]);
	});
}
