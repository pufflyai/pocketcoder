import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import type { CommandContext, CommandRegistrar } from "./commands";
import type { ControlPlaneClient } from "./control-plane";
import type { TargetRef } from "./session-target";

// Turn-level attachment capture for the Pi remote: pasted images, explicit
// @path tokens, and the /attach queue all upload through the PocketCoder
// attachment API before the message referencing them is sent.

export const DIRECT_MODE_ATTACHMENT_ERROR =
	"file attachments need the PocketCoder workspace API; a direct AgentAPI URL (POCKETCODER_AGENTAPI_URL) cannot accept managed uploads";

export interface TurnFile {
	name: string;
	mediaType: string;
	bytes: Uint8Array;
	localPath?: string;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/gif": "gif",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/svg+xml": "svg",
	"image/webp": "webp",
};

const MEDIA_TYPES: Record<string, string> = {
	".csv": "text/csv",
	".gif": "image/gif",
	".html": "text/html",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".json": "application/json",
	".md": "text/markdown",
	".pdf": "application/pdf",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain",
	".webp": "image/webp",
};

function lastUserContent(context: Context): Context["messages"][number]["content"] | undefined {
	const message = context.messages.findLast((candidate) => candidate.role === "user");
	return message?.role === "user" ? message.content : undefined;
}

export function userTextOf(context: Context): string {
	const content = lastUserContent(context);
	if (content === undefined) throw new Error("local Pi did not provide a user message");
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function imageParts(context: Context): TurnFile[] {
	const content = lastUserContent(context);
	if (content === undefined || typeof content === "string") return [];
	return content
		.filter((part) => part.type === "image")
		.map((part) => ({
			name: `pasted-image.${IMAGE_EXTENSIONS[part.mimeType] ?? "bin"}`,
			mediaType: part.mimeType,
			bytes: Uint8Array.from(Buffer.from(part.data, "base64")),
		}));
}

// Explicit `@path` tokens that resolve to a local regular file; quoted forms
// (`@"my file.pdf"`) support spaces.
export function pathTokens(text: string, cwd = process.cwd()): string[] {
	const paths: string[] = [];
	for (const match of text.matchAll(/@(?:"([^"]+)"|(\S+))/g)) {
		const token = (match[1] ?? match[2]) as string;
		const path = isAbsolute(token) ? token : resolve(cwd, token);
		if (isFile(path) && !paths.includes(path)) paths.push(path);
	}
	return paths;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function fileFromPath(path: string): TurnFile {
	return {
		name: basename(path),
		mediaType: MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
		bytes: new Uint8Array(readFileSync(path)),
		localPath: path,
	};
}

export function collectTurnFiles(context: Context, queue: string[], cwd?: string): TurnFile[] {
	const text = userTextOf(context);
	const paths = [...queue];
	for (const path of pathTokens(text, cwd)) {
		if (!paths.includes(path)) paths.push(path);
	}
	return [...imageParts(context), ...paths.map(fileFromPath)];
}

export async function uploadTurnFiles(
	controlPlane: ControlPlaneClient,
	workspaceId: string,
	files: TurnFile[],
): Promise<string[]> {
	const ids: string[] = [];
	for (const file of files) {
		const uploaded = await controlPlane.attachments.upload(workspaceId, {
			name: file.name,
			mediaType: file.mediaType,
			body: file.bytes,
			sizeBytes: file.bytes.byteLength,
		});
		ids.push(uploaded.id);
	}
	return ids;
}

export interface AttachCommandDeps {
	targets: TargetRef;
	queue: string[];
}

export function registerAttachCommand(pi: CommandRegistrar, deps: AttachCommandDeps): void {
	pi.registerCommand("attach", {
		description: "Queue a local file to upload with the next message",
		handler: async (args, ctx: CommandContext) => {
			if (deps.targets.current.mode === "direct") {
				ctx.ui.notify(DIRECT_MODE_ATTACHMENT_ERROR, "warning");
				return;
			}
			const token = args.trim();
			if (!token) {
				ctx.ui.notify("usage: /attach <path>", "info");
				return;
			}
			const path = isAbsolute(token) ? token : resolve(process.cwd(), token);
			if (!isFile(path)) {
				ctx.ui.notify(`no such file: ${token}`, "warning");
				return;
			}
			deps.queue.push(path);
			ctx.ui.notify(
				`queued ${basename(path)} (${deps.queue.length} attachment${deps.queue.length === 1 ? "" : "s"})`,
				"info",
			);
		},
	});
}
