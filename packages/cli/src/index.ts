#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { issueMachineKey } from "@pocketcoder/auth";
import { isScope } from "@pocketcoder/contracts";
import { migrate, migrationStatus, PostgresStore } from "@pocketcoder/db";
import { loadTemplateFile, type Store } from "@pocketcoder/runtime-core";
import { SQL } from "bun";
import { parse as parseDotenv } from "dotenv";
import yargs, { type Argv } from "yargs";

// pocketcoderctl: operator CLI. Key mutation and migrations use direct
// administrative database access; workspace inspection uses the REST API with
// a scoped machine key.

interface Flags {
	[key: string]: unknown;
}

function need(flags: Flags, key: string): string {
	const value = flags[key];
	if (typeof value !== "string" || value === "") {
		fail(`missing required flag --${key}`);
	}
	return value;
}

function fail(message: string): never {
	console.error(`pocketcoderctl: ${message}`);
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

export function createCli(argv: string[]): Argv {
	let parser: Argv = yargs(argv)
		.scriptName("pocketcoderctl")
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
				"  Reads the nearest .env; exported values take precedence",
			].join("\n"),
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
			.command("list", "List template versions from the database"),
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
			),
	);

	return parser
		.command("doctor", "Create, probe, and cancel a diagnostic workspace", (command) =>
			command.option("template", {
				type: "string",
				demandOption: true,
				description: "Template name",
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

	if (group === "db" && action === "migrate") {
		const { url, schema } = dbConfig();
		const sql = new SQL(url);
		const applied = await migrate(sql, schema);
		await sql.end();
		console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "database is up to date");
		return;
	}

	if (group === "db" && action === "status") {
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
		return;
	}

	if (group === "principals" && action === "create") {
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
		return;
	}

	if (group === "principals" && action === "list") {
		await withStore(async (store) => {
			for (const p of await store.listPrincipals()) {
				console.log(
					`${p.name}\t${p.id}\tscopes=${p.scopes.join(",")}\ttemplates=${p.templateNames.join(",") || "-"}${p.disabledAt ? "\tDISABLED" : ""}`,
				);
			}
		});
		return;
	}

	if (group === "keys" && action === "issue") {
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
		return;
	}

	if (group === "keys" && action === "revoke") {
		const id = need(flags, "id");
		await withStore(async (store) => {
			const revoked = await store.revokeMachineKey(id, new Date());
			console.log(revoked ? `revoked ${id}` : `key ${id} not found or already revoked`);
		});
		return;
	}

	if (group === "templates" && action === "validate") {
		if (positional.length === 0) fail("provide at least one template file");
		let ok = true;
		for (const file of positional) {
			try {
				const parsed = await loadTemplateFile(file);
				console.log(
					`${file}: ok (${parsed.manifest.metadata.name}@${parsed.manifest.spec.version}, ${parsed.digest.slice(0, 19)}...)`,
				);
			} catch (err) {
				ok = false;
				console.error(`${file}: INVALID: ${err instanceof Error ? err.message : err}`);
			}
		}
		if (!ok) process.exit(1);
		return;
	}

	if (group === "templates" && action === "list") {
		await withStore(async (store) => {
			for (const t of await store.listTemplates(null)) {
				console.log(`${t.name}@${t.version}\t${t.status}\t${t.digest.slice(0, 19)}...`);
			}
		});
		return;
	}

	if (group === "workspaces" && action === "list") {
		const params = new URLSearchParams();
		for (const [flag, param] of [
			["state", "state"],
			["template", "template"],
			["external-id", "external_id"],
			["limit", "limit"],
		] as const) {
			if (typeof flags[flag] === "string") params.set(param, flags[flag] as string);
		}
		const res = await api(`/v1/workspaces${params.size ? `?${params}` : ""}`);
		const body = (await res.json()) as {
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
			// Active means nonterminal: queued, provisioning, connected,
			// ready, or terminating.
			items = items.filter(
				(w) => !["succeeded", "failed", "canceled", "expired"].includes(w.state),
			);
		}
		if (flags.json) {
			console.log(JSON.stringify(items, null, 2));
			return;
		}
		for (const w of items) {
			console.log(
				`${w.id}\t${w.state}${w.reason_code ? ` (${w.reason_code})` : ""}\t${w.template.name}@${w.template.version}\t${w.external_id}`,
			);
		}
		if (items.length === 0) console.log("(no workspaces)");
		return;
	}

	if (group === "workspaces" && action === "create") {
		const template = need(flags, "template");
		const externalId =
			typeof flags["external-id"] === "string" ? flags["external-id"] : `ctl-${randomUUID()}`;
		let launchInput: Record<string, unknown> | undefined;
		if (typeof flags.input === "string") {
			try {
				launchInput = JSON.parse(flags.input) as Record<string, unknown>;
			} catch {
				fail("--input must be a JSON object");
			}
		}
		const res = await api("/v1/workspaces", {
			method: "POST",
			headers: { "idempotency-key": externalId },
			body: JSON.stringify({
				external_id: externalId,
				template: {
					name: template,
					...(typeof flags.version === "string" ? { version: flags.version } : {}),
				},
				...(launchInput ? { launch_input: launchInput } : {}),
			}),
		});
		console.log(JSON.stringify(await res.json(), null, 2));
		if (!res.ok) process.exit(1);
		return;
	}

	if (group === "workspaces" && action === "get") {
		const res = await api(`/v1/workspaces/${need(flags, "id")}`);
		console.log(JSON.stringify(await res.json(), null, 2));
		return;
	}

	if (group === "workspaces" && action === "logs") {
		const after = typeof flags.after === "string" ? flags.after : "0";
		const limit = typeof flags.limit === "string" ? flags.limit : "200";
		const res = await api(`/v1/workspaces/${need(flags, "id")}/logs?after=${after}&limit=${limit}`);
		const body = (await res.json()) as {
			items?: Array<{ seq: number; stream: string; content: string }>;
		};
		for (const line of body.items ?? []) {
			process.stdout.write(`[${line.stream} #${line.seq}] ${line.content}`);
			if (!line.content.endsWith("\n")) process.stdout.write("\n");
		}
		if ((body.items ?? []).length === 0) console.log("(no logs)");
		return;
	}

	if (group === "workspaces" && action === "cancel") {
		const res = await api(`/v1/workspaces/${need(flags, "id")}/cancel`, {
			method: "POST",
		});
		console.log(JSON.stringify(await res.json(), null, 2));
		return;
	}

	if (group === "doctor") {
		const template = need(flags, "template");
		const externalId = `doctor-${randomUUID()}`;
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
		console.log(`doctor: workspace ${workspace.id} queued; waiting for ready`);
		const deadline = Date.now() + 5 * 60_000;
		let ready = false;
		let terminalState: string | null = null;
		let terminalReason: string | null = null;
		while (Date.now() < deadline) {
			const res = await api(`/v1/workspaces/${workspace.id}`);
			const body = (await res.json()) as {
				state: string;
				reason_code?: string;
			};
			if (body.state === "ready") {
				ready = true;
				break;
			}
			if (["failed", "canceled", "expired"].includes(body.state)) {
				terminalState = body.state;
				terminalReason = body.reason_code ?? "no reason";
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		if (!ready) {
			// Never leak the probe workspace; cancel before reporting.
			await api(`/v1/workspaces/${workspace.id}/cancel`, {
				method: "POST",
			}).catch(() => {});
			if (terminalState) {
				fail(`workspace reached ${terminalState} (${terminalReason})`);
			}
			fail("workspace did not become ready within 5 minutes (probe canceled)");
		}
		console.log("doctor: workspace ready; probing agent status through the relay");
		const statusRes = await api(`/v1/workspaces/${workspace.id}/services/agent/status`);
		console.log(`doctor: relay status ${statusRes.status}: ${await statusRes.text()}`);
		console.log("doctor: canceling probe workspace");
		await api(`/v1/workspaces/${workspace.id}/cancel`, { method: "POST" });
		console.log("doctor: ok");
		return;
	}

	fail(`unsupported command: ${[group, action].filter(Boolean).join(" ")}`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`pocketcoderctl: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
}
