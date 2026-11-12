import { managed } from "@pstdio/pocketcoder-contracts";
import { responseError } from "../../transport/errors";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";
import { contentDisposition } from "../attachments/attachments";
import { sessionPath } from "./sessions";

// Immutable session inputs and retained exports. Both outlive the compute that used them.
export class SessionFilesApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  put(
    sessionId: string,
    file: { inputId: string; name: string; mediaType: string; bytes: Uint8Array },
    options: RequestOptions = {},
  ) {
    return this.transport.request(
      `${sessionPath(sessionId)}/inputs/${encodeURIComponent(file.inputId)}`,
      managed.InputObjectSchema,
      {
        ...options,
        method: "PUT",
        body: file.bytes as RequestInit["body"],
        headers: { "content-type": file.mediaType, "content-disposition": contentDisposition(file.name) },
      },
    );
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
