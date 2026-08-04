import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { isScope } from "@pstdio/pocketcoder-contracts";
import { migrate, migrationStatus } from "@pstdio/pocketcoder-db";
import { loadTemplateFile } from "@pstdio/pocketcoder-runtime-core";
import { SQL } from "bun";
import {
	type CommandContext,
	controlPlaneClient,
	dbConfig,
	fail,
	need,
	valueList,
	withStore,
} from "./cli-context";
import {
	printManagedServerStatus,
	runManagedServer,
	startManagedServer,
	stopManagedServer,
} from "./server-process";

export async function handleServer({ group, action, flags }: CommandContext) {
	if (group !== "server") return false;
	const timeout =
		typeof flags["timeout-seconds"] === "number" ? flags["timeout-seconds"] : undefined;
	if (action === "start") {
		await startManagedServer({
			foreground: flags.foreground === true,
			...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
		});
	} else if (action === "status") await printManagedServerStatus(flags.json === true);
	else if (action === "stop") {
		await stopManagedServer(timeout === undefined ? {} : { timeoutSeconds: timeout });
	} else if (action === "run") await runManagedServer(need(flags, "instance-token"));
	else return false;
	return true;
}

export async function handleDatabase({ group, action }: CommandContext) {
	if (group !== "db" || (action !== "migrate" && action !== "status")) return false;
	const { url, schema } = dbConfig();
	const sql = new SQL(url);
	try {
		if (action === "migrate") {
			const applied = await migrate(sql, schema);
			console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "database is up to date");
		} else {
			for (const migration of await migrationStatus(sql, schema)) {
				const state = migration.drifted
					? "DRIFTED"
					: migration.appliedAt
						? `applied ${migration.appliedAt.toISOString()}`
						: "pending";
				console.log(`${migration.version}\t${state}`);
			}
		}
	} finally {
		await sql.end();
	}
	return true;
}

function scopes(value: string) {
	const items = valueList(value);
	for (const item of items) if (!isScope(item)) fail(`unknown scope: ${item}`);
	return items;
}

export async function handlePrincipals({ group, action, flags }: CommandContext) {
	if (group !== "principals") return false;
	if (action === "create") {
		await withStore(async (store) => {
			const row = await store.createPrincipal(
				need(flags, "name"),
				scopes(need(flags, "scopes")),
				typeof flags.templates === "string" ? valueList(flags.templates) : [],
			);
			console.log(`created principal ${row.name} (${row.id})`);
		});
	} else if (action === "update") {
		await withStore(async (store) => {
			const name = need(flags, "name");
			const principal = await store.getPrincipalByName(name);
			if (!principal) fail(`unknown principal: ${name}`);
			const templates =
				typeof flags.templates === "string" ? valueList(flags.templates) : principal.templateNames;
			const updated = await store.updatePrincipal(
				principal.id,
				scopes(need(flags, "scopes")),
				templates,
			);
			if (!updated) fail(`unknown principal: ${name}`);
			console.log(`updated principal ${updated.name} (${updated.id})`);
		});
	} else if (action === "list") {
		await withStore(async (store) => {
			for (const principal of await store.listPrincipals()) {
				console.log(
					`${principal.name}\t${principal.id}\tscopes=${principal.scopes.join(",")}\ttemplates=${principal.templateNames.join(",") || "-"}${principal.disabledAt ? "\tDISABLED" : ""}`,
				);
			}
		});
	} else return false;
	return true;
}

export async function handleKeys({ group, action, flags }: CommandContext) {
	if (group !== "keys") return false;
	if (action === "issue") {
		const pepper = process.env.POCKETCODER_AUTH_PEPPER;
		if (!pepper) fail("POCKETCODER_AUTH_PEPPER is required to issue keys");
		await withStore(async (store) => {
			const name = need(flags, "principal");
			const principal = await store.getPrincipalByName(name);
			if (!principal) fail(`unknown principal: ${name}`);
			const expiresRaw = typeof flags.expires === "string" ? flags.expires : "never";
			const expiresAt = expiresRaw === "never" ? null : new Date(expiresRaw);
			if (expiresAt && Number.isNaN(expiresAt.getTime()))
				fail(`invalid --expires value: ${expiresRaw}`);
			const key = issueMachineKey(pepper);
			await store.insertMachineKey({
				id: key.id,
				principalId: principal.id,
				secretDigest: key.secretDigest,
				scopes: typeof flags.scopes === "string" ? scopes(flags.scopes) : [],
				createdAt: new Date(),
				expiresAt,
				revokedAt: null,
				lastUsedAt: null,
			});
			console.log("machine key (shown once, store it now):");
			console.log(key.token);
		});
	} else if (action === "revoke") {
		await withStore(async (store) => {
			const id = need(flags, "id");
			const revoked = await store.revokeMachineKey(id, new Date());
			console.log(revoked ? `revoked ${id}` : `key ${id} not found or already revoked`);
		});
	} else return false;
	return true;
}

export async function handleTemplates(context: CommandContext) {
	if (context.group !== "templates") return false;
	if (context.action === "validate") await validateTemplates(context.positional);
	else if (context.action === "list") {
		const items = await controlPlaneClient().templates.list();
		if (context.flags.json) console.log(JSON.stringify(items, null, 2));
		else {
			for (const item of items) {
				console.log(`${item.name}@${item.version}\t${item.status}\t${item.digest.slice(0, 19)}...`);
			}
		}
	} else if (context.action === "list-database") {
		await withStore(async (store) => {
			for (const item of await store.listTemplates(null)) {
				console.log(`${item.name}@${item.version}\t${item.status}\t${item.digest.slice(0, 19)}...`);
			}
		});
	} else return false;
	return true;
}

async function validateTemplates(files: string[]) {
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

export async function handlePools(context: CommandContext) {
	if (context.group !== "pools" || context.action !== "list") return false;
	const body = await controlPlaneClient().administration.warmPools();
	if (context.flags.json) console.log(JSON.stringify(body, null, 2));
	else {
		for (const item of body.items) {
			const counts = Object.entries(item.counts)
				.map(([state, count]) => `${state}=${count}`)
				.join(" ");
			console.log(
				`${item.template}@${item.version}\tdesired=${item.desired}\t${counts || "empty"}\toldest_ready_ms=${item.oldest_ready_age_ms ?? "-"}`,
			);
		}
		console.log(
			`metrics\t${Object.entries(body.metrics)
				.map(([name, value]) => `${name}=${value}`)
				.join(" ")}`,
		);
	}
	return true;
}
