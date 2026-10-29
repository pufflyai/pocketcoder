import {
  type PrincipalCreateRequest,
  PrincipalListResponseSchema,
  PrincipalResourceSchema,
  type PrincipalUpdateRequest,
} from "@pstdio/pocketcoder-contracts";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export class PrincipalsApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  list(options: RequestOptions = {}) {
    return this.transport.request("/v1/principals", PrincipalListResponseSchema, options);
  }

  get(principalId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/principals/${encodeURIComponent(principalId)}`,
      PrincipalResourceSchema,
      options,
    );
  }

  create(input: PrincipalCreateRequest, options: RequestOptions = {}) {
    return this.transport.request("/v1/principals", PrincipalResourceSchema, {
      method: "POST",
      body: JSON.stringify(input),
      signal: options.signal,
    });
  }

  update(principalId: string, input: PrincipalUpdateRequest, options: RequestOptions = {}) {
    return this.transport.request(`/v1/principals/${encodeURIComponent(principalId)}`, PrincipalResourceSchema, {
      method: "PATCH",
      body: JSON.stringify(input),
      signal: options.signal,
    });
  }
}
