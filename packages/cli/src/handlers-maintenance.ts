import { randomUUID } from "node:crypto";
import { isCheckpointState } from "@pstdio/pocketcoder-contracts";
import { type CommandContext, controlPlaneClient, type Flags, fail, need } from "./cli-context";

export async function handleCheckpoints(context: CommandContext) {
	if (context.group !== "checkpoints") return false;
	const commands: Record<string, () => Promise<void>> = {
		list: () => list(context.flags),
		get: async () => {
			console.log(
				JSON.stringify(
					await controlPlaneClient().checkpoints.get(need(context.flags, "id")),
					null,
					2,
				),
			);
		},
		verify: async () => {
			const id = need(context.flags, "id");
			console.log(
				JSON.stringify(
					await controlPlaneClient().checkpoints.verify(id, `verify-${id}-${randomUUID()}`),
					null,
					2,
				),
			);
		},
		delete: async () => {
			const id = need(context.flags, "id");
			console.log(
				JSON.stringify(await controlPlaneClient().checkpoints.delete(id, `delete-${id}`), null, 2),
			);
		},
	};
	const command = context.action ? commands[context.action] : undefined;
	if (!command) return false;
	await command();
	return true;
}

async function list(flags: Flags) {
	const state = typeof flags.state === "string" ? flags.state : undefined;
	const checkpointState = state && isCheckpointState(state) ? state : undefined;
	if (state && !checkpointState) fail(`unknown checkpoint state: ${state}`);
	const result = await controlPlaneClient().checkpoints.list(need(flags, "workspace"), {
		...(checkpointState ? { state: checkpointState } : {}),
	});
	if (flags.json) console.log(JSON.stringify(result.items, null, 2));
	else for (const item of result.items) console.log(JSON.stringify(item));
	if (result.nextCursor) console.log(`next cursor: ${result.nextCursor}`);
}

export async function handleStorage(context: CommandContext) {
	if (context.group !== "storage") return false;
	if (context.action === "prune") {
		console.log(JSON.stringify(await controlPlaneClient().administration.pruneStorage(), null, 2));
		return true;
	}
	if (context.action !== "doctor" && context.action !== "list-orphans") return false;
	const body = await controlPlaneClient().administration.storageInventory();
	if (context.action === "doctor") {
		console.log(
			`storage: ${body.backend}; allocations=${body.storage_count}; checkpoints=${body.checkpoint_count}`,
		);
	}
	for (const id of body.unknown_storage) console.log(`storage\t${id}`);
	for (const id of body.unknown_checkpoints) console.log(`checkpoint\t${id}`);
	if (
		context.action === "list-orphans" &&
		body.unknown_storage.length === 0 &&
		body.unknown_checkpoints.length === 0
	) {
		console.log("(no orphaned physical objects)");
	}
	return true;
}
