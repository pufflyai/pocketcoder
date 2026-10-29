import {
  type AttachmentDescriptor,
  type InputObjectReference,
  InputObjectReferenceSchema,
} from "@pstdio/pocketcoder-contracts";
import type { PocketCoderTransport } from "../../transport/transport";

export { splitAttachmentManifest } from "@pstdio/pocketcoder-contracts";
export type { AttachmentDescriptor };

type UploadBody = NonNullable<RequestInit["body"]>;

export interface AttachmentUploadInput {
  id?: string;
  name: string;
  mediaType?: string;
  body: UploadBody;
  sizeBytes: number;
  sha256?: string;
  signal?: AbortSignal;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
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
  const source = new Response(body).body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
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

  async upload(workspaceId: string, input: AttachmentUploadInput): Promise<InputObjectReference> {
    const id = (input.id ?? crypto.randomUUID()).toLowerCase();
    let sha256 = input.sha256;
    if (!sha256) {
      if (input.body instanceof ReadableStream)
        throw new Error("Stream uploads require sha256 before body consumption.");
      const digest = await crypto.subtle.digest("SHA-256", await new Response(input.body).arrayBuffer());
      sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("sha256 must be 64 lowercase hexadecimal characters.");
    const body = input.onProgress ? progressStream(input.body, input.sizeBytes, input.onProgress) : input.body;
    const init: RequestInit & { duplex?: "half" } = {
      method: "PUT",
      ...(input.signal ? { signal: input.signal } : {}),
      headers: {
        "content-type": input.mediaType ?? "application/octet-stream",
        "content-disposition": contentDisposition(input.name),
        "content-length": String(input.sizeBytes),
        "x-content-sha256": sha256,
      },
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
    };
    return await this.transport.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/attachments/${id}`,
      InputObjectReferenceSchema,
      init,
    );
  }
}
