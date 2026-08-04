import { randomUUID } from "node:crypto";
import {
	AgentMessageRequestSchema,
	ApiError,
	ATTACHMENT_CHUNK_BYTES,
	ATTACHMENT_MAX_FILE_BYTES,
	ATTACHMENT_MAX_MESSAGE_BYTES,
	ATTACHMENTS_MIN_PROTOCOL_VERSION,
	type AttachmentDescriptor,
	AttachmentDescriptorSchema,
	AttachmentMediaTypeSchema,
	type AttachmentResult,
	attachmentManifest,
	isTerminal,
} from "@pstdio/pocketcoder-contracts";
import type { Context } from "hono";
import type { Hub, LiveConnection } from "./hub";
import type { AppEnv } from "./middleware";
import type { RelayDeps } from "./relay";

// Attachment transport between the public HTTP API and the workspace
// supervisor. Bytes stream one acknowledged chunk at a time, so neither the
// server nor the supervisor ever buffers a whole file, and nothing is
// persisted in the control-plane database.

const ACK_TIMEOUT_MS = 30_000;
const RESULT_TIMEOUT_MS = 30_000;
const RESOLVE_TIMEOUT_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function liveConnection(hub: Hub, workspaceId: string): LiveConnection {
	const conn = hub.get(workspaceId);
	if (!conn?.registered) {
		throw new ApiError(
			"workspace.disconnected",
			"The workspace supervisor is not currently connected.",
		);
	}
	if (conn.protocolVersion < ATTACHMENTS_MIN_PROTOCOL_VERSION) {
		throw new ApiError(
			"attachment.unsupported",
			"The connected workspace supervisor does not support attachments.",
		);
	}
	return conn;
}

// Parses the filename from a Content-Disposition header: RFC 5987
// `filename*=UTF-8''…` wins over quoted or bare `filename=` forms.
export function dispositionFilename(header: string): string | null {
	const extended = header.match(/filename\*=(?:utf-8|UTF-8)''([^;]+)/);
	if (extended?.[1]) {
		try {
			return decodeURIComponent(extended[1].trim());
		} catch {
			return null;
		}
	}
	const quoted = header.match(/filename="((?:[^"\\]|\\.)*)"/);
	if (quoted?.[1] !== undefined) return quoted[1].replace(/\\(.)/g, "$1");
	const bare = header.match(/filename=([^";\s]+)/);
	return bare?.[1] ?? null;
}

async function* rechunk(
	stream: ReadableStream<Uint8Array> | null,
	size: number,
): AsyncGenerator<Buffer> {
	if (!stream) return;
	const reader = stream.getReader();
	let pending: Buffer = Buffer.alloc(0);
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			pending = pending.byteLength === 0 ? Buffer.from(value) : Buffer.concat([pending, value]);
			while (pending.byteLength >= size) {
				yield pending.subarray(0, size);
				pending = pending.subarray(size);
			}
		}
	} finally {
		reader.releaseLock();
	}
	if (pending.byteLength > 0) yield pending;
}

function resultError(result: AttachmentResult): ApiError {
	switch (result.status) {
		case "conflict":
			return new ApiError(
				"attachment.conflict",
				"This attachment ID exists with different bytes or metadata.",
			);
		case "failed":
			switch (result.failure_code) {
				case "too_large":
					return new ApiError("attachment.too_large", "The upload exceeded its declared size.");
				case "invalid":
				case "sequence":
					return new ApiError(
						"attachment.invalid",
						result.detail ?? "The supervisor rejected the upload.",
					);
				default:
					return new ApiError(
						"attachment.interrupted",
						"The upload did not complete inside the workspace.",
					);
			}
		default:
			return new ApiError("attachment.interrupted", "The upload finished in an unexpected state.");
	}
}

function expectDescriptor(result: AttachmentResult): AttachmentDescriptor {
	const parsed = AttachmentDescriptorSchema.safeParse(result.descriptor);
	if (!parsed.success) {
		throw new ApiError("attachment.interrupted", "The supervisor returned no valid descriptor.");
	}
	return parsed.data;
}

interface UploadHeaders {
	name: string;
	mediaType: string;
	declared: number;
}

function uploadHeaders(c: Context<AppEnv>): UploadHeaders {
	const disposition = c.req.header("content-disposition") ?? "";
	const name = disposition ? dispositionFilename(disposition) : null;
	if (!name) {
		throw new ApiError(
			"attachment.invalid",
			"A Content-Disposition header with a filename is required.",
		);
	}
	const mediaType = c.req.header("content-type") ?? "application/octet-stream";
	if (!AttachmentMediaTypeSchema.safeParse(mediaType).success) {
		throw new ApiError("attachment.invalid", "Content-Type is not a valid media type.");
	}
	const declaredRaw = c.req.header("content-length") ?? "";
	const declared = Number(declaredRaw);
	if (declaredRaw === "" || !Number.isInteger(declared) || declared < 0) {
		throw new ApiError("attachment.invalid", "An exact Content-Length header is required.");
	}
	if (declared > ATTACHMENT_MAX_FILE_BYTES) {
		throw new ApiError(
			"attachment.too_large",
			`Attachments are limited to ${ATTACHMENT_MAX_FILE_BYTES} bytes.`,
		);
	}
	return { name, mediaType, declared };
}

async function streamUpload(
	hub: Hub,
	conn: LiveConnection,
	operationId: string,
	body: ReadableStream<Uint8Array> | null,
	headers: UploadHeaders,
	attachmentId: string,
): Promise<AttachmentResult> {
	hub.send(conn, "attachment_start", {
		operation_id: operationId,
		attachment_id: attachmentId,
		name: headers.name,
		media_type: headers.mediaType,
		size_bytes: headers.declared,
	});
	let sent = 0;
	let seq = 0;
	for await (const chunk of rechunk(body, ATTACHMENT_CHUNK_BYTES)) {
		sent += chunk.byteLength;
		if (sent > headers.declared) {
			throw new ApiError("attachment.invalid", "The request body exceeds its Content-Length.");
		}
		hub.send(conn, "attachment_chunk", {
			operation_id: operationId,
			seq,
			content_b64: chunk.toString("base64"),
		});
		const event = await hub.nextAttachment(conn, operationId, ACK_TIMEOUT_MS);
		if (event?.kind === "result") return event.payload;
		if (event?.kind !== "ack" || event.payload.seq !== seq) {
			throw new ApiError("attachment.interrupted", "The workspace stopped acknowledging chunks.");
		}
		seq += 1;
	}
	if (sent !== headers.declared) {
		throw new ApiError(
			"attachment.invalid",
			"The request body is shorter than its Content-Length.",
		);
	}
	hub.send(conn, "attachment_finish", { operation_id: operationId });
	const event = await hub.nextAttachment(conn, operationId, RESULT_TIMEOUT_MS);
	if (event?.kind !== "result") {
		throw new ApiError("attachment.interrupted", "The upload was not confirmed by the workspace.");
	}
	return event.payload;
}

export function attachmentUploadHandler(deps: RelayDeps) {
	return async (c: Context<AppEnv>): Promise<Response> => {
		const principal = c.get("principal");
		const id = c.req.param("id") ?? "";
		const attachmentId = (c.req.param("attachmentId") ?? "").toLowerCase();
		const row = await deps.service.getOwned(principal, id);
		if (isTerminal(row.state)) {
			throw new ApiError("workspace.terminal", "This workspace has ended.");
		}
		if (row.state !== "ready") {
			throw new ApiError("workspace.not_ready", "Workspace is not ready.");
		}
		if (!UUID_PATTERN.test(attachmentId)) {
			throw new ApiError("attachment.invalid", "The attachment ID must be a UUID.");
		}
		const headers = uploadHeaders(c);
		const conn = liveConnection(deps.hub, id);
		const operationId = randomUUID();
		deps.hub.openAttachment(conn, operationId);
		try {
			const result = await streamUpload(
				deps.hub,
				conn,
				operationId,
				c.req.raw.body,
				headers,
				attachmentId,
			);
			if (result.status !== "created" && result.status !== "existing") {
				throw resultError(result);
			}
			const descriptor = expectDescriptor(result);
			// Upload activity keeps the workspace from idling out.
			void deps.store
				.updateWorkspace(id, { lastActivityAt: new Date() }, new Date())
				.catch(() => {});
			return c.json(descriptor, result.status === "created" ? 201 : 200);
		} catch (error) {
			abandonUpload(deps.hub, id, conn, operationId, error);
			throw error;
		} finally {
			deps.hub.closeAttachment(conn, operationId);
		}
	};
}

function abandonUpload(
	hub: Hub,
	workspaceId: string,
	conn: LiveConnection,
	operationId: string,
	error: unknown,
): void {
	if (hub.get(workspaceId) !== conn) return;
	const reason = error instanceof Error ? error.message.slice(0, 512) : "upload failed";
	hub.send(conn, "attachment_abort", { operation_id: operationId, reason });
}

async function resolveDescriptors(
	hub: Hub,
	conn: LiveConnection,
	attachmentIds: string[],
): Promise<AttachmentDescriptor[]> {
	const operationId = randomUUID();
	hub.openAttachment(conn, operationId);
	try {
		hub.send(conn, "attachment_resolve", {
			operation_id: operationId,
			attachment_ids: attachmentIds,
		});
		const event = await hub.nextAttachment(conn, operationId, RESOLVE_TIMEOUT_MS);
		if (event?.kind !== "resolved") {
			throw new ApiError(
				"attachment.interrupted",
				"The workspace did not resolve the attachments in time.",
			);
		}
		const descriptors = event.payload.descriptors;
		if (event.payload.missing_id || !descriptors) {
			throw new ApiError(
				"attachment.not_found",
				`Attachment ${event.payload.missing_id ?? "unknown"} was not found in this workspace.`,
			);
		}
		const total = descriptors.reduce((sum, descriptor) => sum + descriptor.size_bytes, 0);
		if (total > ATTACHMENT_MAX_MESSAGE_BYTES) {
			throw new ApiError(
				"attachment.too_large",
				`A message may reference at most ${ATTACHMENT_MAX_MESSAGE_BYTES} attachment bytes.`,
			);
		}
		return descriptors;
	} finally {
		hub.closeAttachment(conn, operationId);
	}
}

// Rewrites an AgentAPI message body that references attachments: IDs resolve
// to descriptors through the supervisor, the generated manifest is appended
// to the content, and `attachment_ids` never reaches AgentAPI. Bodies without
// attachment references pass through byte-identical.
export function agentMessageBodyTransform(deps: RelayDeps) {
	return async (c: Context<AppEnv>, bodyB64: string | undefined): Promise<string | undefined> => {
		if (!bodyB64) return bodyB64;
		const raw = Buffer.from(bodyB64, "base64").toString("utf8");
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			return bodyB64;
		}
		if (typeof json !== "object" || json === null) return bodyB64;
		if ((json as Record<string, unknown>).attachment_ids === undefined) return bodyB64;
		const parsed = AgentMessageRequestSchema.safeParse(json);
		if (!parsed.success || !parsed.data.attachment_ids) {
			throw new ApiError("attachment.invalid", "attachment_ids must be 1-10 unique UUIDs.");
		}
		const { attachment_ids: attachmentIds, ...message } = parsed.data;
		const conn = liveConnection(deps.hub, c.req.param("id") ?? "");
		const descriptors = await resolveDescriptors(deps.hub, conn, attachmentIds);
		const content = `${message.content}\n\n${attachmentManifest(descriptors)}`;
		return Buffer.from(JSON.stringify({ ...message, content })).toString("base64");
	};
}
