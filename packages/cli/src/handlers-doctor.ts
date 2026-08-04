import { randomUUID } from "node:crypto";
import {
	api,
	type CommandContext,
	controlPlaneClient,
	type Flags,
	fail,
	need,
} from "./cli-context";

export async function handleDoctor({ group, flags }: CommandContext) {
	if (group !== "doctor") return false;
	const template = need(flags, "template");
	const externalId = `doctor-${randomUUID()}`;
	console.log(`doctor: creating probe workspace from template ${template}`);
	const workspace = await controlPlaneClient().workspaces.create({
		externalId,
		templateName: template,
	});
	let failure: Error | null = null;
	try {
		console.log(`doctor: workspace ${workspace.id} queued; waiting for ready`);
		await waitUntilReady(workspace.id);
		console.log("doctor: workspace ready; probing agent status through the relay");
		await verifyStatus(workspace.id);
		await runTurn(workspace.id, turnTimeout(flags));
		console.log("doctor: correlated agent response received");
	} catch (error) {
		failure = error instanceof Error ? error : new Error(String(error));
		await printFailureTail(workspace.id);
	} finally {
		console.log("doctor: canceling probe workspace");
		await controlPlaneClient()
			.workspaces.cancel(workspace.id)
			.catch(() => {});
	}
	if (failure) fail(failure.message);
	console.log("doctor: ok");
	return true;
}

function turnTimeout(flags: Flags) {
	const timeout =
		typeof flags["turn-timeout-seconds"] === "number"
			? flags["turn-timeout-seconds"]
			: Number(flags["turn-timeout-seconds"] ?? 60);
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
		fail("--turn-timeout-seconds must be an integer from 1 to 300");
	}
	return timeout;
}

async function waitUntilReady(workspaceId: string) {
	const deadline = Date.now() + 5 * 60_000;
	while (Date.now() < deadline) {
		const workspace = await controlPlaneClient().workspaces.get(workspaceId);
		if (workspace.state === "ready") return;
		if (["failed", "canceled", "expired", "preserved", "succeeded"].includes(workspace.state)) {
			throw new Error(
				`workspace reached ${workspace.state} (${workspace.reason_code ?? "no reason"})`,
			);
		}
		await Bun.sleep(2000);
	}
	throw new Error("workspace did not become ready within 5 minutes");
}

async function verifyStatus(workspaceId: string) {
	const response = await api(`/v1/workspaces/${workspaceId}/agent/status`);
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

async function runTurn(workspaceId: string, timeoutSeconds: number) {
	const nonce = `pocketcoder-doctor-${randomUUID()}`;
	console.log("doctor: sending a correlated request/response probe");
	const response = await api(`/v1/workspaces/${workspaceId}/agent/message`, {
		method: "POST",
		body: JSON.stringify({
			type: "user",
			content: `Reply with exactly this diagnostic token: ${nonce}`,
		}),
	});
	if (!response.ok) {
		throw new Error(`agent message probe failed (${response.status}): ${await response.text()}`);
	}

	const deadline = Date.now() + timeoutSeconds * 1000;
	let after = "0";
	while (Date.now() < deadline) {
		const messagesResponse = await api(
			`/v1/workspaces/${workspaceId}/agent/messages?after=${encodeURIComponent(after)}`,
		);
		if (!messagesResponse.ok) {
			throw new Error(
				`agent messages probe failed (${messagesResponse.status}): ${await messagesResponse.text()}`,
			);
		}
		const body = (await messagesResponse.json()) as { messages?: Array<Record<string, unknown>> };
		const messages = body.messages ?? [];
		if (messages.some((message) => containsNonce(message, nonce))) return;
		const last = messages.at(-1);
		if (last && (typeof last.id === "string" || typeof last.id === "number"))
			after = String(last.id);
		await Bun.sleep(500);
	}
	throw new Error(
		`agent did not return the correlated diagnostic token within ${timeoutSeconds} seconds`,
	);
}

function containsNonce(message: Record<string, unknown>, nonce: string) {
	const role = String(message.role ?? message.type ?? "").toLowerCase();
	return !["user", "human"].includes(role) && JSON.stringify(message).includes(nonce);
}

async function printFailureTail(workspaceId: string) {
	try {
		const workspace = await controlPlaneClient().workspaces.get(workspaceId);
		if (workspace.failure?.log_tail) process.stderr.write(`${workspace.failure.log_tail}\n`);
	} catch {
		// The original diagnostic failure remains authoritative.
	}
}
