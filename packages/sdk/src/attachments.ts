import {
  type AttachmentDescriptor,
  AttachmentDescriptorSchema,
} from "@pstdio/pocketcoder-contracts";
import { PocketCoderError, responseError } from "./errors";
import type { PocketCoderTransport } from "./transport";

export { splitAttachmentManifest } from "@pstdio/pocketcoder-contracts";
export type { AttachmentDescriptor };

type UploadBody = NonNullable<RequestInit["body"]>;

export interface AttachmentUploadInput {
  id?: string;
  name: string;
  mediaType?: string;
  body: UploadBody;
  sizeBytes: number;
  signal?: AbortSignal;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

export interface AgentMessageInput {
  content: string;
  attachmentIds?: string[];
  signal?: AbortSignal;
}

function contentDisposition(name: string): string {
  const clean = name.replace(/[\r\n]/g, "");
  if (/^[ -~]*$/.test(clean)) {
    return `attachment; filename="${clean.replace(/(["\\])/g, "\\$1")}"`;
  }
  return `attachment; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

function progressStream(
  body: UploadBody,
  total: number,
  onProgress: (uploaded: number, total: number) => void,
): ReadableStream<Uint8Array> {
  const source =
    new Response(body).body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  let uploaded = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        uploaded += chunk.byteLength;
        controller.enqueue(chunk);
        onProgress(Math.min(uploaded, total), total);
      },
    }),
  );
}

export class AttachmentsApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  async upload(workspaceId: string, input: AttachmentUploadInput): Promise<AttachmentDescriptor> {
    const id = (input.id ?? crypto.randomUUID()).toLowerCase();
    const body = input.onProgress
      ? progressStream(input.body, input.sizeBytes, input.onProgress)
      : input.body;
    const init: RequestInit & { duplex?: "half" } = {
      method: "PUT",
      ...(input.signal ? { signal: input.signal } : {}),
      headers: {
        "content-type": input.mediaType ?? "application/octet-stream",
        "content-disposition": contentDisposition(input.name),
        "content-length": String(input.sizeBytes),
      },
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
    };
    return await this.transport.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/attachments/${id}`,
      AttachmentDescriptorSchema,
      init,
    );
  }
}

export class AgentApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  // Sends an AgentAPI user message; resolves when the workspace accepted it.
  // The harness response body is service-specific and deliberately not modeled.
  async sendMessage(workspaceId: string, input: AgentMessageInput): Promise<void> {
    const response = await this.transport.raw(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agent/message`,
      {
        method: "POST",
        ...(input.signal ? { signal: input.signal } : {}),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "user",
          content: input.content,
          ...(input.attachmentIds?.length ? { attachment_ids: input.attachmentIds } : {}),
        }),
      },
    );
    if (response.ok) return;
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PocketCoderError({
        message: `PocketCoder returned a non-JSON response (${response.status})`,
        code: "client.non_json_response",
        status: response.status,
      });
    }
    throw responseError(response, body);
  }
}
