import {
  PreviewOpenResponseSchema,
  ScreenshotResourceSchema,
  type ViewSessionOptions,
} from "@pstdio/pocketcoder-contracts";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export class DisplaysApi {
  constructor(private readonly transport: PocketCoderTransport) {}
  capture(workspaceId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/display/screenshot`,
      ScreenshotResourceSchema,
      { method: "POST", body: "{}", signal: options.signal },
    );
  }
  open(workspaceId: string, control = false, options: RequestOptions & { session?: ViewSessionOptions } = {}) {
    return this.transport.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/display`,
      PreviewOpenResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ control, session: options.session ?? { mode: "local" } }),
        signal: options.signal,
      },
    );
  }
}
