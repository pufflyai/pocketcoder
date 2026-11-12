import { managed } from "@pstdio/pocketcoder-contracts";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export class SessionProfilesApi {
  constructor(private readonly transport: PocketCoderTransport) {}
  get(name: string, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/session-profiles/${encodeURIComponent(name)}`,
      managed.SessionProfileSchema,
      options,
    );
  }
}
