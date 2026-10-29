import { createHash } from "node:crypto";
import type { AccountPurgeIntent } from "@pstdio/pocketcoder-contracts";

export { AccountPurgeIntentSchema as PurgeIntentSchema } from "@pstdio/pocketcoder-contracts";
export type PurgeIntent = AccountPurgeIntent;
export const createRequestDigest = (requestId: string) =>
  createHash("sha256").update(`pocketcoder-create-request/v1\0${requestId}`).digest("hex");
export const purgeRequestDigest = (requestId: string) =>
  createHash("sha256").update(`pocketcoder-purge-request/v1\0${requestId}`).digest("hex");
export const intentKeys = (intent: PurgeIntent) => [
  `manager/purge/accounts/${intent.accountId}/intent.json`,
  `manager/purge/requests/${intent.createRequestDigest}/intent.json`,
];
