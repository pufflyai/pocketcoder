#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { isScope } from "@pstdio/pocketcoder-contracts";
import { migrate, migrationStatus, PostgresStore } from "@pstdio/pocketcoder-db";
import { loadTemplateFile, type Store } from "@pstdio/pocketcoder-runtime-core";
import { SQL } from "bun";
import { parse as parseDotenv } from "dotenv";
import yargs, { type Argv } from "yargs";
import {
	printManagedServerStatus,
	runManagedServer,
	startManagedServer,
	stopManagedServer,
} from "./server-process";
import { attachWorkspace, chatWorkspace } from "./workspace-chat";
import { createWorkspace } from "./workspace-create";

// pcd: operator CLI. Key mutation and migrations use direct
// administrative database access; workspace inspection uses the REST API with
// a scoped machine key.

interface Flags {
	[key: string]: unknown;
}

interface CommandContext {
	group: string | undefined;
	action: string | undefined;
	positional: string[];
	flags: Flags;
}

type CommandHandler = (context: CommandContext) => Promise<boolean>;

function need(flags: Flags, key: string): string {
	const value = flags[key];
	if (typeof value !== "string" || value === "") {
		fail(`missing required flag --${key}`);
	}
	return value;
}

function fail(message: string): never {
	console.error(`pcd: ${message}`);
	process.exit(1);
}

function findEnvironmentFile(startDirectory: string): string | undefined {
	let directory = resolve(startDirectory);
	while (true) {
		const candidate = join(directory, ".env");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function loadProjectEnvironment(flags: Flags): void {
	const workdirValue = flags.workdir;
	const workdir =
		typeof workdirValue === "string" && workdirValue !== ""
			? resolve(process.cwd(), workdirValue)
			: process.cwd();
	try {
		if (!statSync(workdir).isDirectory()) {
			fail(`work directory is not a directory: ${workdir}`);
		}
	} catch {
		fail(`work directory does not exist: ${workdir}`);
	}

	if (typeof workdirValue === "string") process.chdir(workdir);

	const envFileValue = flags["env-file"];
	const explicitEnvFile =
		typeof envFileValue === "string" && envFileValue !== ""
			? resolve(workdir, envFileValue)
			: undefined;
	const envFile = explicitEnvFile ?? findEnvironmentFile(workdir);
	if (!envFile) return;
	if (explicitEnvFile && !existsSync(explicitEnvFile)) {
		fail(`environment file does not exist: ${explicitEnvFile}`);
	}

	let parsed: Record<string, string>;
	try {
		parsed = parseDotenv(readFileSync(envFile));
	} catch (error) {
		fail(
			`could not read environment file ${envFile}: ${error instanceof Error ? error.message : error}`,
		);
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

function dbConfig(): { url: string; schema: string } {
	const url = process.env.POCKETCODER_DATABASE_URL;
	if (!url) fail("POCKETCODER_DATABASE_URL is required for this command");
	return {
		url,
		schema: process.env.POCKETCODER_DATABASE_SCHEMA ?? "pocketcoder",
	};
}

function apiConfig(): { url: string; key: string } {
	const url = process.env.POCKETCODER_URL ?? "http://127.0.0.1:7080";
	const key = process.env.POCKETCODER_KEY;
	if (!key) fail("POCKETCODER_KEY is required for this command");
	return { url, key };
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
	const { url, key } = apiConfig();
	return await fetch(`${url}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${key}`,
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
	});
}

async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
	const { url, schema } = dbConfig();
	const store = new PostgresStore(url, schema);
	try {
		return await fn(store);
	} finally {
		await store.close();
	}
}

function commandGroup(
	parser: Argv,
	name: string,
	description: string,
	configure: (group: Argv) => Argv,
): Argv {
	return parser.command(`${name} <command>`, description, (group) =>
		configure(group).demandCommand(1, `A ${name} command is required.`).strict(),
	);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The yargs command tree is declarative and easier to audit in one place.
export function createCli(argv: string[]): Argv {
	let parser: Argv = yargs(argv)
		.scriptName("pcd")
		.usage("$0 <command>")
		.parserConfiguration({ "camel-case-expansion": false })
		.option("workdir", {
			type: "string",
			description: "Pocketcoder project directory used for .env discovery",
		})
		.option("env-file", {
			type: "string",
			description: "Explicit environment file, relative to --workdir",
		})
		.help()
		.alias("help", "h")
		.version(false)
		.recommendCommands()
		.showHelpOnFail(true)
		.epilogue(
			[
				"Environment:",
				"  POCKETCODER_DATABASE_URL, POCKETCODER_DATABASE_SCHEMA (db/key/template commands)",
				"  POCKETCODER_URL, POCKETCODER_KEY (workspace and doctor commands)",
				"  POCKETCODER_AUTH_PEPPER (key issuance)",
				"  POCKETCODER_STATE_DIR (managed server state and message cursors)",
				"  Reads the nearest .env; exported values take precedence",
			].join("\n"),
		);

	parser = commandGroup(parser, "server", "Manage only the PocketCoder server process", (group) =>
		group
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

	parser = commandGroup(parser, "db", "Manage database migrations", (group) =>
		group
			.command("migrate", "Apply pending migrations to the configured schema")
			.command("status", "Show migration status"),
	);

	parser = commandGroup(parser, "principals", "Manage principals", (group) =>
		group
			.command("create", "Create a principal", (command) =>
				command
					.option("name", {
						type: "string",
						demandOption: true,
						description: "Principal name",
					})
					.option("scopes", {
						type: "string",
						demandOption: true,
						description: "Comma-separated scopes",
					})
					.option("templates", {
						type: "string",
						description: "Comma-separated template names, or * for all templates",
					}),
			)
			.command("list", "List principals"),
	);

	parser = commandGroup(parser, "keys", "Manage machine keys", (group) =>
		group
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
						description: "Expiration as ISO 8601, or never",
						default: "never",
					}),
			)
			.command("revoke", "Revoke a machine key", (command) =>
				command.option("id", {
					type: "string",
					demandOption: true,
					description: "Machine key ID",
				}),
			),
	);

	parser = commandGroup(parser, "templates", "Validate and inspect templates", (group) =>
		group
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

	parser = commandGroup(parser, "workspaces", "Manage workspaces", (group) =>
		group
			.command("list", "List workspaces", (command) =>
				command
					.option("active", {
						type: "boolean",
						description: "Only show nonterminal workspaces",
					})
					.option("state", {
						type: "string",
						description: "Filter by state",
					})
					.option("template", {
						type: "string",
						description: "Filter by template name",
					})
					.option("external-id", {
						type: "string",
						description: "Filter by external ID",
					})
					.option("limit", {
						type: "string",
						description: "Maximum number of workspaces",
					})
					.option("json", {
						type: "boolean",
						description: "Print JSON",
					}),
			)
			.command("create", "Create a workspace", (command) =>
				command
					.option("template", {
						type: "string",
						demandOption: true,
						description: "Template name",
					})
					.option("version", {
						type: "string",
						description: "Template version",
					})
					.option("external-id", {
						type: "string",
						description: "Caller identity and idempotency key",
					})
					.option("input", {
						type: "string",
						description: "Launch input as a JSON object",
					})
					.option("source", {
						type: "string",
						description: "Template-declared repository alias",
					})
					.option("revision", {
						type: "string",
						description: "Allowed Git branch, tag, or commit",
					})
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
					}),
			)
			.command("get", "Get a workspace", (command) =>
				command.option("id", {
					type: "string",
					demandOption: true,
					description: "Workspace ID",
				}),
			)
			.command("logs", "Read workspace logs", (command) =>
				command
					.option("id", {
						type: "string",
						demandOption: true,
						description: "Workspace ID",
					})
					.option("after", {
						type: "string",
						description: "Only show log lines after this sequence",
					})
					.option("limit", {
						type: "string",
						description: "Maximum number of log lines",
					}),
			)
			.command("cancel", "Cancel a workspace", (command) =>
				command.option("id", {
					type: "string",
					demandOption: true,
					description: "Workspace ID",
				}),
			)
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
			.command("outputs", "Read audited template-declared outputs", (command) =>
				command.option("id", { type: "string", demandOption: true }),
			)
			.command("attach", "Read or send AgentAPI messages on a live workspace", (command) =>
				command
					.option("id", { type: "string", demandOption: true })
					.option("after", { type: "string" })
					.option("message", { type: "string" })
					.option("json", { type: "boolean" }),
			)
			.command("chat", "Hold an interactive AgentAPI conversation", (command) =>
				command
					.option("id", { type: "string", demandOption: true })
					.option("after", { type: "string" })
					.option("message", { type: "string" })
					.option("follow", {
						type: "boolean",
						description: "Continue following messages until interrupted",
					})
					.option("json", {
						type: "boolean",
						description: "Print messages as newline-delimited JSON",
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
					}),
			),
	);

	parser = commandGroup(parser, "checkpoints", "Inspect retained workspace checkpoints", (group) =>
		group
			.command("list", "List checkpoints for a workspace", (command) =>
				command
					.option("workspace", { type: "string", demandOption: true })
					.option("state", { type: "string" })
					.option("json", { type: "boolean" }),
			)
			.command("get", "Get checkpoint metadata", (command) =>
				command.option("id", { type: "string", demandOption: true }),
			)
			.command("verify", "Verify checkpoint manifest and content", (command) =>
				command.option("id", { type: "string", demandOption: true }),
			)
			.command("delete", "Delete checkpoint content and metadata asynchronously", (command) =>
				command.option("id", { type: "string", demandOption: true }),
			),
	);

	parser = commandGroup(parser, "storage", "Inspect and maintain checkpoint storage", (group) =>
		group
			.command("doctor", "Check the configured storage backend and inventory")
			.command("list-orphans", "List physical objects with no durable metadata")
			.command("prune", "Delete checkpoints whose retention has expired"),
	);

	return parser
		.command("doctor", "Create, probe, and cancel a diagnostic workspace", (command) =>
			command
				.option("template", {
					type: "string",
					demandOption: true,
					description: "Template name",
				})
				.option("turn-timeout-seconds", {
					type: "number",
					default: 60,
					description: "Maximum time to wait for the correlated diagnostic response",
				}),
		)
		.demandCommand(1, "A command is required.")
		.strict();
}

async function main(): Promise<void> {
	const parsed = await createCli(process.argv.slice(2)).parseAsync();
	const [groupValue, actionValue] = parsed._;
	const group = groupValue === undefined ? undefined : String(groupValue);
	const action = actionValue === undefined ? undefined : String(actionValue);
	const positional = Array.isArray(parsed.files) ? parsed.files.map(String) : [];
	const flags = parsed as unknown as Flags;
	loadProjectEnvironment(flags);
	const context = { group, action, positional, flags };
	if (await dispatchCommand(context)) return;
	fail(`unsupported command: ${[group, action].filter(Boolean).join(" ")}`);
}

async function handleServer({ group, action, flags }: CommandContext): Promise<boolean> {
	if (group !== "server") return false;
	const timeout =
		typeof flags["timeout-seconds"] === "number" ? flags["timeout-seconds"] : undefined;
	switch (action) {
		case "start":
			await startManagedServer({
				foreground: flags.foreground === true,
				...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
			});
			return true;
		case "status":
			await printManagedServerStatus(flags.json === true);
			return true;
		case "stop":
			await stopManagedServer(timeout === undefined ? {} : { timeoutSeconds: timeout });
			return true;
		case "run":
			await runManagedServer(need(flags, "instance-token"));
			return true;
		default:
			return false;
	}
}

async function handleDatabase({ group, action }: CommandContext): Promise<boolean> {
	if (group !== "db") return false;
	if (action === "migrate") {
		const { url, schema } = dbConfig();
		const sql = new SQL(url);
		const applied = await migrate(sql, schema);
		await sql.end();
		console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "database is up to date");
		return true;
	}

	if (action === "status") {
		const { url, schema } = dbConfig();
		const sql = new SQL(url);
		const status = await migrationStatus(sql, schema);
		await sql.end();
		for (const m of status) {
			const state = m.drifted
				? "DRIFTED"
				: m.appliedAt
					? `applied ${m.appliedAt.toISOString()}`
					: "pending";
			console.log(`${m.version}\t${state}`);
		}
		return true;
	}
	return false;
}

async function handlePrincipals({ group, action, flags }: CommandContext): Promise<boolean> {
	if (group !== "principals") return false;
	if (action === "create") {
		const name = need(flags, "name");
		const scopes = need(flags, "scopes")
			.split(",")
			.map((s) => s.trim());
		for (const scope of scopes) {
			if (!isScope(scope)) fail(`unknown scope: ${scope}`);
		}
		const templates =
			typeof flags.templates === "string" ? flags.templates.split(",").map((s) => s.trim()) : [];
		await withStore(async (store) => {
			const row = await store.createPrincipal(name, scopes, templates);
			console.log(`created principal ${row.name} (${row.id})`);
		});
		return true;
	}

	if (action === "list") {
		await withStore(async (store) => {
			for (const p of await store.listPrincipals()) {
				console.log(
					`${p.name}\t${p.id}\tscopes=${p.scopes.join(",")}\ttemplates=${p.templateNames.join(",") || "-"}${p.disabledAt ? "\tDISABLED" : ""}`,
				);
			}
		});
		return true;
	}
	return false;
}

async function handleKeys({ group, action, flags }: CommandContext): Promise<boolean> {
	if (group !== "keys") return false;
	if (action === "issue") {
		const pepper = process.env.POCKETCODER_AUTH_PEPPER;
		if (!pepper) fail("POCKETCODER_AUTH_PEPPER is required to issue keys");
		const principalName = need(flags, "principal");
		await withStore(async (store) => {
			const principal = await store.getPrincipalByName(principalName);
			if (!principal) fail(`unknown principal: ${principalName}`);
			const scopes =
				typeof flags.scopes === "string"
					? flags.scopes.split(",").map((s) => s.trim())
					: principal.scopes;
			const expiresRaw = typeof flags.expires === "string" ? flags.expires : "never";
			const expiresAt = expiresRaw === "never" ? null : new Date(expiresRaw);
			if (expiresAt && Number.isNaN(expiresAt.getTime())) {
				fail(`invalid --expires value: ${expiresRaw}`);
			}
			const issued = issueMachineKey(pepper);
			await store.insertMachineKey({
				id: issued.id,
				principalId: principal.id,
				secretDigest: issued.secretDigest,
				scopes,
				createdAt: new Date(),
				expiresAt,
				revokedAt: null,
				lastUsedAt: null,
			});
			console.log("machine key (shown once, store it now):");
			console.log(issued.token);
		});
		return true;
	}

	if (action === "revoke") {
		const id = need(flags, "id");
		await withStore(async (store) => {
			const revoked = await store.revokeMachineKey(id, new Date());
			console.log(revoked ? `revoked ${id}` : `key ${id} not found or already revoked`);
		});
		return true;
	}
	return false;
}

async function validateTemplates(files: string[]): Promise<void> {
	if (files.length === 0) fail("provide at least one template file");
	let valid = true;
	for (const file of files) {
		try {
			const parsed = await loadTemplateFile(file);
			console.log(
				`${file}: ok (${parsed.manifest.metadata.name}@${parsed.manifest.spec.version}, ${parsed.digest.slice(0, 19)}...)`,
			);
		} catch (error) {
			valid = false;
			console.error(`${file}: INVALID: ${error instanceof Error ? error.message : error}`);
		}
	}
	if (!valid) process.exit(1);
}

async function listTemplates(flags: Flags): Promise<void> {
	const response = await api("/v1/templates");
	const body = (await response.json()) as {
		items?: Array<{ name: string; version: string; status: string; digest: string }>;
	};
	if (!response.ok) {
		fail(`template discovery failed (${response.status}): ${JSON.stringify(body)}`);
	}
	if (flags.json) {
		console.log(JSON.stringify(body.items ?? [], null, 2));
		return;
	}
	for (const template of body.items ?? []) {
		console.log(
			`${template.name}@${template.version}\t${template.status}\t${template.digest.slice(0, 19)}...`,
		);
	}
}

async function listDatabaseTemplates(): Promise<void> {
	await withStore(async (store) => {
		for (const template of await store.listTemplates(null)) {
			console.log(
				`${template.name}@${template.version}\t${template.status}\t${template.digest.slice(0, 19)}...`,
			);
		}
	});
}

async function handleTemplates(context: CommandContext): Promise<boolean> {
	if (context.group !== "templates") return false;
	switch (context.action) {
		case "validate":
			await validateTemplates(context.positional);
			return true;
		case "list":
			await listTemplates(context.flags);
			return true;
		case "list-database":
			await listDatabaseTemplates();
			return true;
		default:
			return false;
	}
}

async function listWorkspaces(flags: Flags): Promise<void> {
	const params = new URLSearchParams();
	for (const [flag, param] of [
		["state", "state"],
		["template", "template"],
		["external-id", "external_id"],
		["limit", "limit"],
	] as const) {
		if (typeof flags[flag] === "string") params.set(param, flags[flag] as string);
	}
	const response = await api(`/v1/workspaces${params.size ? `?${params}` : ""}`);
	const body = (await response.json()) as {
		items?: Array<{
			id: string;
			external_id: string;
			state: string;
			reason_code: string | null;
			template: { name: string; version: string };
		}>;
	};
	let items = body.items ?? [];
	if (flags.active) {
		items = items.filter(
			(workspace) =>
				!["succeeded", "failed", "canceled", "expired", "preserved"].includes(workspace.state),
		);
	}
	if (flags.json) {
		console.log(JSON.stringify(items, null, 2));
		return;
	}
	for (const workspace of items) {
		console.log(
			`${workspace.id}\t${workspace.state}${workspace.reason_code ? ` (${workspace.reason_code})` : ""}\t${workspace.template.name}@${workspace.template.version}\t${workspace.external_id}`,
		);
	}
	if (items.length === 0) console.log("(no workspaces)");
}

async function getWorkspace(flags: Flags): Promise<void> {
	const response = await api(`/v1/workspaces/${need(flags, "id")}`);
	console.log(JSON.stringify(await response.json(), null, 2));
}

async function readWorkspaceLogs(flags: Flags): Promise<void> {
	const after = typeof flags.after === "string" ? flags.after : "0";
	const limit = typeof flags.limit === "string" ? flags.limit : "200";
	const response = await api(
		`/v1/workspaces/${need(flags, "id")}/logs?after=${after}&limit=${limit}`,
	);
	const body = (await response.json()) as {
		items?: Array<{ seq: number; stream: string; content: string }>;
	};
	for (const line of body.items ?? []) {
		process.stdout.write(`[${line.stream} #${line.seq}] ${line.content}`);
		if (!line.content.endsWith("\n")) process.stdout.write("\n");
	}
	if ((body.items ?? []).length === 0) console.log("(no logs)");
}

async function cancelWorkspace(flags: Flags): Promise<void> {
	const response = await api(`/v1/workspaces/${need(flags, "id")}/cancel`, {
		method: "POST",
	});
	console.log(JSON.stringify(await response.json(), null, 2));
}

async function handleWorkspaceCore(context: CommandContext): Promise<boolean> {
	if (context.group !== "workspaces") return false;
	const commands: Record<string, () => Promise<void>> = {
		list: () => listWorkspaces(context.flags),
		create: () => createWorkspace(context.flags, { api, fail }),
		get: () => getWorkspace(context.flags),
		logs: () => readWorkspaceLogs(context.flags),
		cancel: () => cancelWorkspace(context.flags),
	};
	const command = context.action ? commands[context.action] : undefined;
	if (!command) return false;
	await command();
	return true;
}

async function handleWorkspacePersistence({
	group,
	action,
	flags,
}: CommandContext): Promise<boolean> {
	if (group !== "workspaces") return false;
	if (action === "preserve") {
		const id = need(flags, "id");
		const body = {
			...(typeof flags.retention === "string" ? { retention: flags.retention } : {}),
			...(typeof flags.label === "string" ? { label: flags.label } : {}),
		};
		const res = await api(`/v1/workspaces/${id}/preserve`, {
			method: "POST",
			headers: { "idempotency-key": `preserve-${id}-${randomUUID()}` },
			body: JSON.stringify(body),
		});
		console.log(JSON.stringify(await res.json(), null, 2));
		if (!res.ok) process.exit(1);
		return true;
	}

	if (action === "restore") {
		const externalId = need(flags, "external-id");
		const res = await api(`/v1/checkpoints/${need(flags, "checkpoint")}/restore`, {
			method: "POST",
			headers: { "idempotency-key": externalId },
			body: JSON.stringify({ external_id: externalId }),
		});
		console.log(JSON.stringify(await res.json(), null, 2));
		if (!res.ok) process.exit(1);
		return true;
	}

	if (action === "recreate") {
		const externalId = need(flags, "external-id");
		const res = await api(`/v1/workspaces/${need(flags, "id")}/recreate`, {
			method: "POST",
			headers: { "idempotency-key": externalId },
			body: JSON.stringify({ external_id: externalId }),
		});
		console.log(JSON.stringify(await res.json(), null, 2));
		if (!res.ok) process.exit(1);
		return true;
	}

	if (action === "outputs") {
		const res = await api(`/v1/workspaces/${need(flags, "id")}/outputs`);
		console.log(JSON.stringify(await res.json(), null, 2));
		if (!res.ok) process.exit(1);
		return true;
	}
	return false;
}

async function handleWorkspaceAttach({ group, action, flags }: CommandContext): Promise<boolean> {
	if (group !== "workspaces" || action !== "attach") return false;
	await attachWorkspace(flags, { api, fail });
	return true;
}

async function handleWorkspaceChat({ group, action, flags }: CommandContext): Promise<boolean> {
	if (group !== "workspaces" || action !== "chat") return false;
	await chatWorkspace(flags, { api, fail });
	return true;
}

async function listCheckpoints(flags: Flags): Promise<void> {
	const params = new URLSearchParams();
	if (typeof flags.state === "string") params.set("state", flags.state);
	const response = await api(
		`/v1/workspaces/${need(flags, "workspace")}/checkpoints${params.size ? `?${params}` : ""}`,
	);
	const body = (await response.json()) as { items?: unknown[] };
	if (flags.json) console.log(JSON.stringify(body.items ?? [], null, 2));
	else for (const item of body.items ?? []) console.log(JSON.stringify(item));
	if (!response.ok) process.exit(1);
}

async function getCheckpoint(flags: Flags): Promise<void> {
	const response = await api(`/v1/checkpoints/${need(flags, "id")}`);
	console.log(JSON.stringify(await response.json(), null, 2));
	if (!response.ok) process.exit(1);
}

async function verifyCheckpoint(flags: Flags): Promise<void> {
	const id = need(flags, "id");
	const response = await api(`/v1/checkpoints/${id}/verify`, {
		method: "POST",
		headers: { "idempotency-key": `verify-${id}-${randomUUID()}` },
	});
	console.log(JSON.stringify(await response.json(), null, 2));
	if (!response.ok) process.exit(1);
}

async function deleteCheckpoint(flags: Flags): Promise<void> {
	const id = need(flags, "id");
	const response = await api(`/v1/checkpoints/${id}`, {
		method: "DELETE",
		headers: { "idempotency-key": `delete-${id}` },
	});
	console.log(JSON.stringify(await response.json(), null, 2));
	if (!response.ok) process.exit(1);
}

async function handleCheckpoints(context: CommandContext): Promise<boolean> {
	if (context.group !== "checkpoints") return false;
	const commands: Record<string, () => Promise<void>> = {
		list: () => listCheckpoints(context.flags),
		get: () => getCheckpoint(context.flags),
		verify: () => verifyCheckpoint(context.flags),
		delete: () => deleteCheckpoint(context.flags),
	};
	const command = context.action ? commands[context.action] : undefined;
	if (!command) return false;
	await command();
	return true;
}

async function inspectStorage(action: "doctor" | "list-orphans"): Promise<void> {
	const response = await api("/v1/storage/inventory");
	const body = (await response.json()) as {
		backend?: string;
		storage_count?: number;
		checkpoint_count?: number;
		unknown_storage?: string[];
		unknown_checkpoints?: string[];
	};
	if (!response.ok) {
		fail(`storage inventory failed (${response.status}): ${JSON.stringify(body)}`);
	}
	if (action === "doctor") {
		console.log(
			`storage: ${body.backend ?? "unknown"}; allocations=${body.storage_count ?? 0}; checkpoints=${body.checkpoint_count ?? 0}`,
		);
	}
	for (const id of body.unknown_storage ?? []) console.log(`storage\t${id}`);
	for (const id of body.unknown_checkpoints ?? []) console.log(`checkpoint\t${id}`);
	const noOrphans =
		(body.unknown_storage?.length ?? 0) === 0 && (body.unknown_checkpoints?.length ?? 0) === 0;
	if (action === "list-orphans" && noOrphans) console.log("(no orphaned physical objects)");
}

async function pruneStorage(): Promise<void> {
	const response = await api("/v1/storage/prune", { method: "POST" });
	console.log(JSON.stringify(await response.json(), null, 2));
	if (!response.ok) process.exit(1);
}

async function handleStorage(context: CommandContext): Promise<boolean> {
	if (context.group !== "storage") return false;
	if (context.action === "doctor" || context.action === "list-orphans") {
		await inspectStorage(context.action);
		return true;
	}
	if (context.action !== "prune") return false;
	await pruneStorage();
	return true;
}

interface DoctorWorkspaceResource {
	state: string;
	reason_code?: string | null;
	failure?: { log_tail?: string } | null;
}

function doctorTurnTimeout(flags: Flags): number {
	const timeout =
		typeof flags["turn-timeout-seconds"] === "number"
			? flags["turn-timeout-seconds"]
			: Number(flags["turn-timeout-seconds"] ?? 60);
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
		fail("--turn-timeout-seconds must be an integer from 1 to 300");
	}
	return timeout;
}

async function waitForDoctorReady(workspaceId: string): Promise<void> {
	const deadline = Date.now() + 5 * 60_000;
	while (Date.now() < deadline) {
		const response = await api(`/v1/workspaces/${workspaceId}`);
		if (!response.ok) {
			throw new Error(`workspace lookup failed (${response.status}): ${await response.text()}`);
		}
		const workspace = (await response.json()) as DoctorWorkspaceResource;
		if (workspace.state === "ready") return;
		if (["failed", "canceled", "expired", "preserved", "succeeded"].includes(workspace.state)) {
			throw new Error(
				`workspace reached ${workspace.state} (${workspace.reason_code ?? "no reason"})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	throw new Error("workspace did not become ready within 5 minutes");
}

async function verifyDoctorStatus(workspaceId: string): Promise<void> {
	const response = await api(`/v1/workspaces/${workspaceId}/services/agent/status`);
	const text = await response.text();
	console.log(`doctor: relay status ${response.status}: ${text}`);
	if (!response.ok) throw new Error(`agent status probe failed (${response.status})`);
	let body: { status?: unknown };
	try {
		body = JSON.parse(text) as { status?: unknown };
	} catch {
		throw new Error("agent status probe returned invalid JSON");
	}
	if (body.status !== "running" && body.status !== "stable") {
		throw new Error(`agent status probe returned unknown status: ${JSON.stringify(body.status)}`);
	}
}

function containsDoctorNonce(message: Record<string, unknown>, nonce: string): boolean {
	const role = String(message.role ?? message.type ?? "").toLowerCase();
	return !["user", "human"].includes(role) && JSON.stringify(message).includes(nonce);
}

async function runDoctorTurn(workspaceId: string, timeoutSeconds: number): Promise<void> {
	const nonce = `pocketcoder-doctor-${randomUUID()}`;
	console.log("doctor: sending a correlated request/response probe");
	const messageResponse = await api(`/v1/workspaces/${workspaceId}/services/agent/message`, {
		method: "POST",
		body: JSON.stringify({
			type: "user",
			content: `Reply with exactly this diagnostic token: ${nonce}`,
		}),
	});
	if (!messageResponse.ok) {
		throw new Error(
			`agent message probe failed (${messageResponse.status}): ${await messageResponse.text()}`,
		);
	}

	const deadline = Date.now() + timeoutSeconds * 1000;
	let after = "0";
	while (Date.now() < deadline) {
		const response = await api(
			`/v1/workspaces/${workspaceId}/services/agent/messages?after=${encodeURIComponent(after)}`,
		);
		if (!response.ok) {
			throw new Error(`agent messages probe failed (${response.status}): ${await response.text()}`);
		}
		const body = (await response.json()) as { messages?: Array<Record<string, unknown>> };
		const messages = body.messages ?? [];
		if (messages.some((message) => containsDoctorNonce(message, nonce))) return;
		const last = messages.at(-1);
		if (last && (typeof last.id === "string" || typeof last.id === "number")) {
			after = String(last.id);
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(
		`agent did not return the correlated diagnostic token within ${timeoutSeconds} seconds`,
	);
}

async function printDoctorFailureTail(workspaceId: string): Promise<void> {
	try {
		const response = await api(`/v1/workspaces/${workspaceId}`);
		if (!response.ok) return;
		const body = (await response.json()) as DoctorWorkspaceResource;
		if (body.failure?.log_tail) process.stderr.write(`${body.failure.log_tail}\n`);
	} catch {
		// The original diagnostic failure remains authoritative.
	}
}

async function handleDoctor({ group, flags }: CommandContext): Promise<boolean> {
	if (group !== "doctor") return false;
	const template = need(flags, "template");
	const externalId = `doctor-${randomUUID()}`;
	const turnTimeoutSeconds = doctorTurnTimeout(flags);
	console.log(`doctor: creating probe workspace from template ${template}`);
	const createRes = await api("/v1/workspaces", {
		method: "POST",
		headers: { "idempotency-key": externalId },
		body: JSON.stringify({
			external_id: externalId,
			template: { name: template },
		}),
	});
	if (!createRes.ok) {
		fail(`create failed (${createRes.status}): ${await createRes.text()}`);
	}
	const workspace = (await createRes.json()) as { id: string };
	let failure: Error | null = null;
	try {
		console.log(`doctor: workspace ${workspace.id} queued; waiting for ready`);
		await waitForDoctorReady(workspace.id);

		console.log("doctor: workspace ready; probing agent status through the relay");
		await verifyDoctorStatus(workspace.id);
		await runDoctorTurn(workspace.id, turnTimeoutSeconds);
		console.log("doctor: correlated agent response received");
	} catch (error) {
		failure = error instanceof Error ? error : new Error(String(error));
		await printDoctorFailureTail(workspace.id);
	} finally {
		console.log("doctor: canceling probe workspace");
		await api(`/v1/workspaces/${workspace.id}/cancel`, { method: "POST" }).catch(() => {});
	}
	if (failure) fail(failure.message);
	console.log("doctor: ok");
	return true;
}

async function dispatchCommand(context: CommandContext): Promise<boolean> {
	const handlers: CommandHandler[] = [
		handleServer,
		handleDatabase,
		handlePrincipals,
		handleKeys,
		handleTemplates,
		handleWorkspaceCore,
		handleWorkspacePersistence,
		handleWorkspaceAttach,
		handleWorkspaceChat,
		handleCheckpoints,
		handleStorage,
		handleDoctor,
	];
	for (const handler of handlers) {
		if (await handler(context)) return true;
	}
	return false;
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`pcd: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
}
