import type { Argv } from "yargs";

export function addWorkspaceCommands(parser: Argv) {
	return parser.command("workspaces <command>", "Manage workspaces", (workspaces) =>
		workspaces
			.command("list", "List workspaces", listOptions)
			.command("create", "Create a workspace", createOptions)
			.command("get", "Get a workspace", idOption)
			.command("logs", "Read workspace logs", paginationOptions)
			.command("network-events", "Read durable workspace egress decisions", paginationOptions)
			.command("terminal-sessions", "Read audited terminal sessions", paginationOptions)
			.command("terminal", "Open or reattach to an interactive terminal", (command) =>
				idOption(command).option("session", {
					type: "string",
					description: "Existing terminal session ID to reattach",
				}),
			)
			.command("cancel", "Cancel a workspace", idOption)
			.command("preserve", "Stop and checkpoint a persistence-enabled workspace", (command) =>
				command
					.option("id", { type: "string", demandOption: true })
					.option("retention", { type: "string" })
					.option("label", { type: "string" }),
			)
			.command("restore", "Restore a checkpoint into a new workspace execution", (command) =>
				command
					.option("checkpoint", { type: "string", demandOption: true })
					.option("external-id", { type: "string", demandOption: true }),
			)
			.command("recreate", "Restore a workspace's latest ready checkpoint", (command) =>
				command
					.option("id", { type: "string", demandOption: true })
					.option("external-id", { type: "string", demandOption: true }),
			)
			.command("outputs", "Read audited template-declared outputs", idOption)
			.command("attach", "Read or send AgentAPI messages on a live workspace", attachOptions)
			.command("chat", "Hold an interactive AgentAPI conversation", chatOptions)
			.demandCommand(1, "A workspaces command is required.")
			.strict(),
	);
}

function listOptions(command: Argv) {
	return command
		.option("active", { type: "boolean", description: "Only show nonterminal workspaces" })
		.option("state", { type: "string", description: "Filter by state" })
		.option("template", { type: "string", description: "Filter by template name" })
		.option("external-id", { type: "string", description: "Filter by external ID" })
		.option("limit", { type: "string", description: "Maximum number of workspaces" })
		.option("json", { type: "boolean", description: "Print JSON" });
}

// `version(false)` because here `--version` names the template version, not the root version flag.
function createOptions(command: Argv) {
	return command
		.version(false)
		.option("template", { type: "string", demandOption: true, description: "Template name" })
		.option("version", { type: "string", description: "Template version" })
		.option("external-id", { type: "string", description: "Caller identity and idempotency key" })
		.option("input", { type: "string", description: "Launch input as a JSON object" })
		.option("source", { type: "string", description: "Template-declared repository alias" })
		.option("revision", { type: "string", description: "Allowed Git branch, tag, or commit" })
		.option("wait", {
			type: "boolean",
			description: "Wait until the workspace is ready or terminal",
		})
		.option("wait-timeout-seconds", {
			type: "number",
			default: 300,
			description: "Maximum time to wait for readiness",
		})
		.option("cancel-on-exit", {
			type: "boolean",
			description: "Cancel the workspace if waiting is interrupted",
		})
		.option("json", {
			type: "boolean",
			description: "Print only the final workspace resource as JSON",
		});
}

function idOption(command: Argv) {
	return command.option("id", { type: "string", demandOption: true, description: "Workspace ID" });
}

function paginationOptions(command: Argv) {
	return idOption(command)
		.option("cursor", { type: "string", description: "Continue from an opaque pagination cursor" })
		.option("limit", { type: "string", description: "Maximum number of records" });
}

function attachOptions(command: Argv) {
	return idOption(command)
		.option("after", { type: "string" })
		.option("message", { type: "string" })
		.option("file", {
			type: "string",
			array: true,
			description: "Local file to upload as an attachment (repeatable, requires --message)",
		})
		.option("json", { type: "boolean" });
}

function chatOptions(command: Argv) {
	return attachOptions(command)
		.option("follow", {
			type: "boolean",
			description: "Continue following messages until interrupted",
		})
		.option("poll-interval-ms", {
			type: "number",
			default: 500,
			description: "Agent message polling interval",
		})
		.option("response-timeout-seconds", {
			type: "number",
			default: 600,
			description: "Maximum time to wait for each agent response",
		})
		.option("cancel-on-exit", {
			type: "boolean",
			description: "Cancel the workspace when chat exits",
		});
}
