import {
  StorageInventorySchema,
  StoragePruneResultSchema,
  WarmPoolInventorySchema,
} from "@pstdio/pocketcoder-contracts";
import type { PocketCoderTransport, RequestOptions } from "./transport";

export class AdministrationApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  warmPools(options: RequestOptions = {}) {
    return this.transport.request("/v1/warm-pools", WarmPoolInventorySchema, options);
  }

  storageInventory(options: RequestOptions = {}) {
    return this.transport.request("/v1/storage/inventory", StorageInventorySchema, options);
  }

  pruneStorage(options: RequestOptions = {}) {
    return this.transport.request("/v1/storage/prune", StoragePruneResultSchema, {
      method: "POST",
      signal: options.signal,
    });
  }
}
