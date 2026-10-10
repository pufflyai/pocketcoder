import { PreviewOpenResponseSchema } from "@pstdio/pocketcoder-contracts";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export class DisplaysApi {
  constructor(private readonly transport: PocketCoderTransport) {}
  open(workspaceId: string, control = false, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/display`,
      PreviewOpenResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ control }),
        signal: options.signal,
      },
    );
  }
}
