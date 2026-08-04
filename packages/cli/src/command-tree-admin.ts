import type { Argv } from "yargs";

function group(
	parser: Argv,
	name: string,
	description: string,
	configure: (commands: Argv) => Argv,
) {
	return parser.command(`${name} <command>`, description, (commands) =>
		configure(commands).demandCommand(1, `A ${name} command is required.`).strict(),
	);
}

export function addAdministrativeCommands(parser: Argv) {
	let commands = group(parser, "server", "Manage only the PocketCoder server process", (server) =>
		server
			.command("start", "Start the configured PocketCoder server", (command) =>
				command
					.option("foreground", {
						type: "boolean",
						description: "Run attached until SIGINT or SIGTERM",
					})
					.option("timeout-seconds", {
						type: "number",
						default: 30,
						description: "Maximum time to wait for server health",
					}),
			)
			.command("status", "Show managed server process and health", (command) =>
				command.option("json", { type: "boolean", description: "Print JSON" }),
			)
			.command("stop", "Gracefully stop the managed PocketCoder server", (command) =>
				command.option("timeout-seconds", {
					type: "number",
					default: 15,
					description: "Maximum time to wait for graceful shutdown",
				}),
			)
			.command("run", false, (command) =>
				command.option("instance-token", {
					type: "string",
					demandOption: true,
					hidden: true,
				}),
			),
	);
	commands = group(commands, "db", "Manage database migrations", (database) =>
		database
			.command("migrate", "Apply pending migrations to the configured schema")
			.command("status", "Show migration status"),
	);
	commands = group(commands, "principals", "Manage principals", (principals) =>
		principals
			.command("create", "Create a principal", principalOptions)
			.command("update", "Update a principal", principalOptions)
			.command("list", "List principals"),
	);
	commands = group(commands, "keys", "Manage machine keys", (keys) =>
		keys
			.command("issue", "Issue a machine key", (command) =>
				command
					.option("principal", {
						type: "string",
						demandOption: true,
						description: "Principal name",
					})
					.option("scopes", {
						type: "string",
						description: "Comma-separated scopes; defaults to the principal scopes",
					})
					.option("expires", {
						type: "string",
						default: "never",
						description: "Expiration as ISO 8601, or never",
					}),
			)
			.command("revoke", "Revoke a machine key", (command) =>
				command.option("id", { type: "string", demandOption: true, description: "Machine key ID" }),
			),
	);
	commands = group(commands, "templates", "Validate and inspect templates", (templates) =>
		templates
			.command("validate <files..>", "Validate template manifests offline", (command) =>
				command.positional("files", {
					type: "string",
					array: true,
					description: "Template manifest files",
				}),
			)
			.command("list", "List authorized template versions through the REST API", (command) =>
				command.option("json", { type: "boolean", description: "Print JSON" }),
			)
			.command("list-database", "List every template version from PostgreSQL"),
	);
	commands = group(commands, "pools", "Inspect operator-managed warm capacity", (pools) =>
		pools.command("list", "List warm pool inventory and metrics", (command) =>
			command.option("json", { type: "boolean", description: "Print JSON" }),
		),
	);
	commands = group(commands, "checkpoints", "Inspect retained workspace checkpoints", (items) =>
		items
			.command("list", "List checkpoints for a workspace", (command) =>
				command
					.option("workspace", { type: "string", demandOption: true })
					.option("state", { type: "string" })
					.option("json", { type: "boolean" }),
			)
			.command("get", "Get checkpoint metadata", idOption)
			.command("verify", "Verify checkpoint manifest and content", idOption)
			.command("delete", "Delete checkpoint content and metadata asynchronously", idOption),
	);
	commands = group(commands, "storage", "Inspect and maintain checkpoint storage", (storage) =>
		storage
			.command("doctor", "Check the configured storage backend and inventory")
			.command("list-orphans", "List physical objects with no durable metadata")
			.command("prune", "Delete checkpoints whose retention has expired"),
	);
	return commands.command("doctor", "Create, probe, and cancel a diagnostic workspace", (command) =>
		command
			.option("template", { type: "string", demandOption: true, description: "Template name" })
			.option("turn-timeout-seconds", {
				type: "number",
				default: 60,
				description: "Maximum time to wait for the correlated diagnostic response",
			}),
	);
}

function principalOptions(command: Argv) {
	return command
		.option("name", { type: "string", demandOption: true, description: "Principal name" })
		.option("scopes", { type: "string", demandOption: true, description: "Comma-separated scopes" })
		.option("templates", {
			type: "string",
			description: "Comma-separated template names, or * for all templates",
		});
}

function idOption(command: Argv) {
	return command.option("id", { type: "string", demandOption: true });
}
