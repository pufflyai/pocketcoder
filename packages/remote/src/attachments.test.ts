import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import {
	collectTurnFiles,
	DIRECT_MODE_ATTACHMENT_ERROR,
	pathTokens,
	registerAttachCommand,
	uploadTurnFiles,
} from "./attachments";
import { RemoteAgentClient } from "./client";
import type { CommandContext, CommandRegistrar } from "./commands";
import { ControlPlaneClient } from "./control-plane";
import { formatConversationMessage, type ThemeLike } from "./renderers";
import { TargetRef } from "./session-target";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-attach-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function contextWith(content: string | Context["messages"][number]["content"]): Context {
	return {
		messages: [{ role: "user", content, timestamp: 0 }],
	} as unknown as Context;
}

const PNG_BYTES = Buffer.from("fake png bytes");

describe("collectTurnFiles", () => {
	test("converts Pi image parts into named uploads", () => {
		const context = contextWith([
			{ type: "text", text: "what is this?" },
			{ type: "image", data: PNG_BYTES.toString("base64"), mimeType: "image/png" },
		]);
		const files = collectTurnFiles(context, []);
		expect(files).toHaveLength(1);
		expect(files[0]?.name).toBe("pasted-image.png");
		expect(files[0]?.mediaType).toBe("image/png");
		expect(Buffer.from(files[0]?.bytes ?? []).equals(PNG_BYTES)).toBe(true);
	});

	test("picks up @path tokens that resolve to local files", () => {
		const dir = tempDir();
		const file = join(dir, "report.pdf");
		writeFileSync(file, "pdf bytes");
		const context = contextWith(`summarize @${file} and ignore @/missing/nope.txt`);
		const files = collectTurnFiles(context, []);
		expect(files.map((f) => f.name)).toEqual(["report.pdf"]);
	});

	test("merges the /attach queue without duplicating @path files", () => {
		const dir = tempDir();
		const queued = join(dir, "queued.csv");
		const mentioned = join(dir, "mentioned.txt");
		writeFileSync(queued, "a,b");
		writeFileSync(mentioned, "text");
		const context = contextWith(`compare @${mentioned} with @${queued}`);
		const files = collectTurnFiles(context, [queued]);
		expect(files.map((f) => f.name).sort()).toEqual(["mentioned.txt", "queued.csv"]);
	});
});

describe("pathTokens", () => {
	test("supports quoted paths with spaces", () => {
		const dir = tempDir();
		const spaced = join(dir, "my report.pdf");
		writeFileSync(spaced, "x");
		expect(pathTokens(`read @"${spaced}" now`)).toEqual([spaced]);
	});
});

describe("uploadTurnFiles", () => {
	test("uploads each file through the control plane and returns ids in order", async () => {
		const requests: Request[] = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const request =
				input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
			requests.push(request);
			const id = new URL(request.url).pathname.split("/").at(-1) as string;
			return Response.json(
				{
					id,
					name: "report.pdf",
					path: `/home/pocketcoder/.pcd/attachments/${id}/report.pdf`,
					media_type: "application/pdf",
					size_bytes: 9,
					sha256: "a".repeat(64),
				},
				{ status: 201 },
			);
		}) as typeof fetch;
		const controlPlane = new ControlPlaneClient(
			{ baseUrl: "http://pocketcoder.test", key: "pkt_example" },
			fetchImpl,
		);
		const workspaceId = randomUUID();
		const ids = await uploadTurnFiles(controlPlane, workspaceId, [
			{
				name: "report.pdf",
				mediaType: "application/pdf",
				bytes: new TextEncoder().encode("pdf bytes"),
			},
		]);
		expect(ids).toHaveLength(1);
		const request = requests[0] as Request;
		expect(request.method).toBe("PUT");
		expect(new URL(request.url).pathname).toBe(
			`/v1/workspaces/${workspaceId}/attachments/${ids[0]}`,
		);
		expect(request.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
	});
});

describe("RemoteAgentClient with attachments", () => {
	test("includes attachment_ids in the AgentAPI message body", async () => {
		const requests: Request[] = [];
		let sent = false;
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const request =
				input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
			requests.push(request);
			const path = new URL(request.url).pathname;
			if (request.method === "POST" && path.endsWith("/message")) {
				sent = true;
				return Response.json({ ok: true });
			}
			if (path.endsWith("/messages")) {
				return Response.json({
					messages: sent ? [{ id: 1, role: "agent", content: "done" }] : [],
				});
			}
			if (path.endsWith("/status")) return Response.json({ status: "stable" });
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		const client = new RemoteAgentClient(
			{
				serviceUrl: "http://x.test/v1/workspaces/ws/agent",
				key: "k",
				pollIntervalMs: 1,
				timeoutMs: 200,
			},
			fetchImpl,
		);
		const ids = [randomUUID()];
		await client.send("look at this", undefined, ids);
		const message = requests.find(
			(request) => request.method === "POST" && request.url.endsWith("/message"),
		);
		expect(await (message as Request).json()).toEqual({
			content: "look at this",
			type: "user",
			attachment_ids: ids,
		});
	});
});

describe("/attach command", () => {
	function fakeUi(notices: string[]) {
		return {
			hasUI: true,
			ui: {
				notify: (message: string) => notices.push(message),
				select: async () => undefined,
				confirm: async () => false,
				input: async () => undefined,
				setWorkingMessage: () => {},
			},
			newSession: async () => ({ cancelled: false }),
		} as unknown as CommandContext;
	}

	function register(targets: TargetRef, queue: string[]) {
		const handlers = new Map<string, (args: string, ctx: CommandContext) => Promise<void>>();
		const registrar: CommandRegistrar = {
			registerCommand: (name, options) => handlers.set(name, options.handler),
		};
		registerAttachCommand(registrar, { targets, queue });
		return handlers.get("attach") as (args: string, ctx: CommandContext) => Promise<void>;
	}

	test("queues existing files in relay mode", async () => {
		const dir = tempDir();
		const file = join(dir, "report.pdf");
		writeFileSync(file, "x");
		const queue: string[] = [];
		const notices: string[] = [];
		const targets = new TargetRef({ mode: "unset", baseUrl: "http://x", key: "k" });
		const handler = register(targets, queue);

		await handler(file, fakeUi(notices));
		expect(queue).toEqual([file]);
		expect(notices[0]).toContain("report.pdf");

		await handler("/missing/nope.txt", fakeUi(notices));
		expect(queue).toEqual([file]);
		expect(notices[1]).toContain("no such file");
	});

	test("explains that direct AgentAPI mode cannot accept uploads", async () => {
		const queue: string[] = [];
		const notices: string[] = [];
		const targets = new TargetRef({ mode: "direct", key: "k", serviceUrl: "http://agentapi" });
		const handler = register(targets, queue);
		await handler("whatever.txt", fakeUi(notices));
		expect(queue).toEqual([]);
		expect(notices[0]).toBe(DIRECT_MODE_ATTACHMENT_ERROR);
	});
});

describe("history rendering", () => {
	const theme: ThemeLike = { fg: (_color, text) => text, bold: (text) => text };

	test("hides the generated manifest and shows attachment names instead", () => {
		const manifest = `<pocketcoder-attachments>\n${JSON.stringify([
			{
				id: randomUUID(),
				name: "report.pdf",
				path: "/home/pocketcoder/.pcd/attachments/x/report.pdf",
				media_type: "application/pdf",
				size_bytes: 42_137,
				sha256: "a".repeat(64),
			},
		])}\n</pocketcoder-attachments>`;
		const rendered = formatConversationMessage(
			{
				role: "user",
				content: `Summarize the report.\n\n${manifest}`,
				seq: 1,
				occurred_at: "2026-08-04T10:00:00.000Z",
			},
			theme,
		);
		expect(rendered).toContain("Summarize the report.");
		expect(rendered).toContain("report.pdf");
		expect(rendered).not.toContain("<pocketcoder-attachments>");
		expect(rendered).not.toContain("/home/pocketcoder/.pcd");
	});
});
