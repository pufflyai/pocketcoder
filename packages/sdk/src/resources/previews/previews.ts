import { PreviewListSchema, PreviewOpenResponseSchema } from "@pstdio/pocketcoder-contracts";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export class PreviewsApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  list(workspaceId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/previews`,
      PreviewListSchema,
      options,
    );
  }

  open(workspaceId: string, name: string, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/previews/${encodeURIComponent(name)}`,
      PreviewOpenResponseSchema,
      {
        method: "POST",
        signal: options.signal,
      },
    );
  }
}
