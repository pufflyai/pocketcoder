import { ApiError, digestOf, type SecretPutRequest } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceLeaseRow } from "@pstdio/pocketcoder-runtime-core";
import { z } from "zod";

type IssuerConfig = Extract<SecretPutRequest, { type: "setup-issuer" }>["value"];
const IdentitySchema = z.strictObject({
  workspace_id: z.uuid(),
  source_url: z.url(),
  source_revision: z.string().min(1),
  template_digest: z.string(),
  request_id: z.uuid(),
  request_digest: z.string(),
  policy_digest: z.string(),
  purpose: z.literal("setup-issuer"),
  expires_at: z.iso.datetime(),
  policy: z.record(z.string(), z.json()),
});
const MintSchema = IdentitySchema.extend({
  lease_id: z.string().min(1).max(1024),
  credential: z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0") && Buffer.byteLength(value) <= 32_768),
});
const RevokeSchema = IdentitySchema.extend({ revoked: z.literal(true) });
const unavailable = () => new ApiError("secret.unavailable", "Workspace issuer is unavailable.");
const identityOf = (row: WorkspaceLeaseRow) => ({
  workspace_id: row.workspaceId,
  source_url: row.sourceUrl,
  source_revision: row.sourceRevision,
  template_digest: row.templateDigest,
  request_id: row.requestId,
  request_digest: row.requestDigest,
  policy_digest: row.policyDigest,
  purpose: row.purpose,
  expires_at: row.requestExpiresAt.toISOString(),
});

async function readReply(response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 131_072) throw unavailable();
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function createIssuerClient(options: { ca?: string } = {}) {
  async function post<T>(
    config: IssuerConfig,
    row: WorkspaceLeaseRow,
    operation: "mint" | "revoke",
    validate: (reply: unknown) => T,
  ) {
    // The vault owns the destination, authentication and policy. Redirects cannot
    // carry controller authority to a destination chosen by an issuer response.
    try {
      if (digestOf(config.policy) !== row.policyDigest) throw unavailable();
      const response = await fetch(config.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: { authorization: config.authorization, "content-type": "application/json" },
        body: JSON.stringify({ operation, ...identityOf(row), policy: config.policy }),
        ...(options.ca ? { tls: { ca: options.ca } } : {}),
      });
      return validate(await readReply(response));
    } catch {
      throw unavailable();
    }
  }
  function bound(row: WorkspaceLeaseRow, result: z.infer<typeof IdentitySchema>) {
    const expected = identityOf(row);
    if (
      result.workspace_id !== expected.workspace_id ||
      result.source_url !== expected.source_url ||
      result.source_revision !== expected.source_revision ||
      result.template_digest !== expected.template_digest ||
      result.request_id !== expected.request_id ||
      result.request_digest !== expected.request_digest ||
      result.policy_digest !== expected.policy_digest ||
      result.purpose !== expected.purpose ||
      digestOf(result.policy) !== row.policyDigest
    )
      throw unavailable();
  }
  return {
    mint(config: IssuerConfig, row: WorkspaceLeaseRow) {
      return post(config, row, "mint", (reply) => {
        const parsed = MintSchema.safeParse(reply);
        if (!parsed.success) throw unavailable();
        bound(row, parsed.data);
        const expiresAt = new Date(parsed.data.expires_at);
        if (expiresAt <= row.createdAt || expiresAt > row.requestExpiresAt) throw unavailable();
        return { leaseId: parsed.data.lease_id, credential: parsed.data.credential, expiresAt };
      });
    },
    revoke(config: IssuerConfig, row: WorkspaceLeaseRow) {
      return post(config, row, "revoke", (reply) => {
        const parsed = RevokeSchema.safeParse(reply);
        if (!parsed.success) throw unavailable();
        bound(row, parsed.data);
        if (parsed.data.expires_at !== row.requestExpiresAt.toISOString()) throw unavailable();
      });
    },
  };
}
