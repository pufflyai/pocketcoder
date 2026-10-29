import {
  ExpiringKeyListResponseSchema,
  type KeyIssueRequest,
  KeyIssueResponseSchema,
  KeyListResponseSchema,
  type KeyRotateRequest,
  OperationResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { queryString } from "../../transport/common";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export interface KeyListQuery {
  limit?: number;
  cursor?: string;
  requestId?: string;
}

export class KeysApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  list(principalId: string, query: KeyListQuery = {}, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/principals/${encodeURIComponent(principalId)}/keys?${queryString({ limit: query.limit, cursor: query.cursor, request_id: query.requestId })}`,
      KeyListResponseSchema,
      options,
    );
  }

  async *all(principalId: string, query: Omit<KeyListQuery, "cursor"> = {}, options: RequestOptions = {}) {
    let cursor: string | undefined;
    do {
      const page = await this.list(principalId, { ...query, cursor }, options);
      yield* page.items;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  // Active keys that expire within the window, soonest first. The server default is 168 hours.
  expiring(query: { withinHours?: number } = {}, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/keys/expiring?${queryString({ within_hours: query.withinHours })}`,
      ExpiringKeyListResponseSchema,
      options,
    );
  }

  issue(principalId: string, input: KeyIssueRequest, options: RequestOptions = {}) {
    return this.transport.request(`/v1/principals/${encodeURIComponent(principalId)}/keys`, KeyIssueResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
      signal: options.signal,
    });
  }

  // Issues a successor with the same grants; the rotated key stays valid until you revoke it.
  rotate(principalId: string, keyId: string, input: KeyRotateRequest, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/principals/${encodeURIComponent(principalId)}/keys/${encodeURIComponent(keyId)}/rotate`,
      KeyIssueResponseSchema,
      { method: "POST", body: JSON.stringify(input), signal: options.signal },
    );
  }

  revoke(principalId: string, keyId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/principals/${encodeURIComponent(principalId)}/keys/${encodeURIComponent(keyId)}`,
      z.object({ revoked: z.literal(true) }),
      { method: "DELETE", signal: options.signal },
    );
  }

  revokeAll(principalId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/principals/${encodeURIComponent(principalId)}/keys`,
      z.object({ revoked: z.literal(true) }),
      { method: "DELETE", signal: options.signal },
    );
  }
}

export class RecoveryApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  purge(principalId: string, workspaceId: string, executionKey: string, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/principals/${encodeURIComponent(principalId)}/workspaces/${encodeURIComponent(workspaceId)}/purge`,
      OperationResourceSchema,
      { method: "POST", headers: { "Idempotency-Key": executionKey }, body: "{}", signal: options.signal },
    );
  }

  operation(principalId: string, operationId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/principals/${encodeURIComponent(principalId)}/operations/${encodeURIComponent(operationId)}`,
      OperationResourceSchema,
      options,
    );
  }
}
