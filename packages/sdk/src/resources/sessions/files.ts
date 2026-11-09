import { managed } from "@pstdio/pocketcoder-contracts";
import { responseError } from "../../transport/errors";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";
import { sessionPath } from "./sessions";

// Immutable session inputs and retained exports. Both outlive the compute that used them.
export class SessionFilesApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  // Registers the identity of one file before its bytes are uploaded.
  register(sessionId: string, input: managed.InputUpload, options: RequestOptions = {}) {
    return this.transport.request(`${sessionPath(sessionId)}/inputs`, managed.InputObjectSchema, {
      ...options,
      method: "POST",
      body: JSON.stringify(managed.InputUploadSchema.parse(input)),
    });
  }

  // Uploads exact bytes. The server checks length and digest before the input becomes ready.
  upload(sessionId: string, inputId: string, bytes: Uint8Array, options: RequestOptions = {}) {
    return this.transport.request(
      `${sessionPath(sessionId)}/inputs/${encodeURIComponent(inputId)}/content`,
      managed.InputObjectSchema,
      {
        ...options,
        method: "PUT",
        body: bytes as RequestInit["body"],
        headers: { "content-type": "application/octet-stream" },
      },
    );
  }

  // Registers and uploads one file. Retrying with the same inputId and bytes is safe.
  async put(
    sessionId: string,
    file: { inputId: string; name: string; mediaType: managed.InputUpload["mediaType"]; bytes: Uint8Array },
    options: RequestOptions = {},
  ) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", file.bytes as Uint8Array<ArrayBuffer>));
    const sha256 = `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const registered = await this.register(
      sessionId,
      { inputId: file.inputId, name: file.name, mediaType: file.mediaType, sizeBytes: file.bytes.byteLength, sha256 },
      options,
    );
    if (registered.state === "ready") return registered;
    return this.upload(sessionId, file.inputId, file.bytes, options);
  }

  get(sessionId: string, inputId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `${sessionPath(sessionId)}/inputs/${encodeURIComponent(inputId)}`,
      managed.InputObjectSchema,
      options,
    );
  }

  exports(sessionId: string, requestId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `${sessionPath(sessionId)}/exports?requestId=${encodeURIComponent(requestId)}`,
      managed.ManagedExportPageSchema,
      options,
    );
  }

  // Retained bytes, readable without live compute. Expired or deleted content is a 404.
  async content(sessionId: string, exportId: string, options: RequestOptions = {}) {
    const response = await this.transport.raw(
      `${sessionPath(sessionId)}/exports/${encodeURIComponent(exportId)}/content`,
      options,
    );
    if (!response.ok) {
      const text = await response.text();
      throw responseError(response, text ? JSON.parse(text) : undefined);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
