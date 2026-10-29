import { SecretListSchema, type SecretPutRequest, SecretResourceSchema } from "@pstdio/pocketcoder-contracts";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export class SecretsApi {
  constructor(private readonly transport: PocketCoderTransport) {}
  async put(name: string, input: SecretPutRequest, options: RequestOptions = {}) {
    return this.transport.request(`/v1/secrets/${encodeURIComponent(name)}`, SecretResourceSchema, {
      ...options,
      method: "PUT",
      body: JSON.stringify(input),
    });
  }
  async list(options: RequestOptions = {}) {
    return (await this.transport.request("/v1/secrets", SecretListSchema, options)).items;
  }
  async retire(name: string, options: RequestOptions = {}) {
    return this.transport.request(`/v1/secrets/${encodeURIComponent(name)}`, SecretResourceSchema, {
      ...options,
      method: "DELETE",
    });
  }
}
