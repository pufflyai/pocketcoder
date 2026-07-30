#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { issueMachineKey } from "@pocketcoder/auth";
import { isScope } from "@pocketcoder/contracts";
import { migrate, migrationStatus, PostgresStore } from "@pocketcoder/db";
import { loadTemplateFile, type Store } from "@pocketcoder/runtime-core";
import { SQL } from "bun";

// pocketcoderctl: operator CLI. Key mutation and migrations use direct
// administrative database access; workspace inspection uses the REST API with
// a scoped machine key.

interface Flags {
	[key: string]: string | boolean;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
	const positional: string[] = [];
	const flags: Flags = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i += 1;
			} else {
				flags[key] = true;
			}
		} else {
			positional.push(arg);
		}
	}
	return { positional, flags };
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

const USAGE = `usage: pocketcoderctl <command>

  db migrate                     apply pending migrations to the configured schema
  db status                      show migration status
  principals create --name <n> --scopes <a,b> [--templates <t1,t2|*>]
  principals list
  keys issue --principal <name> [--scopes <a,b>] [--expires <ISO8601|never>]
  keys revoke --id <key-id>
  templates validate <file...>   validate template manifests offline
  templates list                 list template versions (database)
  workspaces list [--active] [--state <s>] [--template <t>] [--external-id <x>] [--limit <n>] [--json]
  workspaces create --template <name> [--version <v>] [--external-id <x>] [--input '<json>']
  workspaces get --id <id>
  workspaces logs --id <id> [--after <seq>] [--limit <n>]
  workspaces cancel --id <id>
  doctor --template <name>       create, converse with, and delete a probe workspace

environment:
  POCKETCODER_DATABASE_URL, POCKETCODER_DATABASE_SCHEMA (db/key/template commands)
  POCKETCODER_URL, POCKETCODER_KEY (workspace and doctor commands)
  POCKETCODER_AUTH_PEPPER (key issuance)`;

async function main(): Promise<void> {
	const [group, action, ...restArgs] = process.argv.slice(2);
	const { positional, flags } = parseArgs(restArgs);

	if (!group || group === "help" || group === "--help" || group === "-h") {
		console.log(USAGE);
		return;
	}

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
		// doctor has no action word, so its flags start right after the group.
		const { flags: doctorFlags } = parseArgs(process.argv.slice(3));
		const template = need(doctorFlags, "template");
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

	console.log(USAGE);
	process.exit(1);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`pocketcoderctl: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
}
