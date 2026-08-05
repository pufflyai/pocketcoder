import { expect, test } from "bun:test";
import { prepareCheckpoint } from "./checkpoint-coordinator";

test("checkpoint preparation closes terminals before quiescing the workspace", async () => {
	const order: string[] = [];
	await prepareCheckpoint("11111111-1111-4111-8111-111111111111", 100, {
		exec: () => null,
		send: (type, payload) => {
			if (type === "checkpoint_status") {
				order.push(String((payload as { phase: string }).phase));
			}
			return true;
		},
		pump: async () => {},
		readAgentApiStatus: async () => null,
		syncAgentApiMessages: async () => {},
		child: () => null,
		childExited: () => false,
		closeTerminals: async () => {
			order.push("terminals_closed");
		},
		setQuiescing: () => {},
	});

	expect(order).toEqual(["terminals_closed", "quiescing", "failed"]);
});
