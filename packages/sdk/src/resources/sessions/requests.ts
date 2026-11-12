import { managed } from "@pstdio/pocketcoder-contracts";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";
import { sessionPath } from "./sessions";

const requestPath = (sessionId: string, requestId: string) =>
  `${sessionPath(sessionId)}/requests/${encodeURIComponent(requestId)}`;

// Logical requests of a session. Persist `requestId` before submitting and resend the exact same
// body after an uncertain reply: the server returns the original request instead of running it twice.
export class SessionRequestsApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  submit(sessionId: string, input: managed.RequestInput, options: RequestOptions = {}) {
    return this.transport.request(`${sessionPath(sessionId)}/requests`, managed.RequestSchema, {
      ...options,
      method: "POST",
      body: JSON.stringify(managed.RequestInputSchema.parse(input)),
    });
  }

  get(sessionId: string, requestId: string, options: RequestOptions = {}) {
    return this.transport.request(requestPath(sessionId, requestId), managed.RequestSchema, options);
  }

  // Stops one request. Queued work ends without dispatch; running work stays pending until the
  // producer reports its terminal state. A request that already completed keeps its outcome.
  cancel(sessionId: string, requestId: string, options: RequestOptions = {}) {
    return this.transport.request(`${requestPath(sessionId, requestId)}/cancel`, managed.CancelReceiptSchema, {
      ...options,
      method: "POST",
    });
  }

  // The collection receipt exists even with no files. Pending, empty complete, partial and lost
  // are distinct; an empty object list alone is never proof of success.
  collection(sessionId: string, requestId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `${requestPath(sessionId, requestId)}/collection`,
      managed.CollectionResultSchema,
      options,
    );
  }
}
