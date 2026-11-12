import { ApiError, type SecretPutRequest } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceLeaseRow } from "@pstdio/pocketcoder-runtime-core";
import { z } from "zod";

type IssuerConfig = Extract<SecretPutRequest, { type: "setup-issuer" }>["value"];
const MintSchema = z.strictObject({
  credential: z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0") && Buffer.byteLength(value) <= 32_768),
  expires_at: z.iso.datetime(),
});
const unavailable = () => new ApiError("secret.unavailable", "Workspace issuer is unavailable.");
export class CredentialsRefused extends Error {
  constructor() {
    super("Session credentials were refused.");
  }
}
async function readReply(response: Response) {
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
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
  async function post(config: IssuerConfig, body: object) {
    try {
      const response = await fetch(config.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: { authorization: config.authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(options.ca ? { tls: { ca: options.ca } } : {}),
      });
      if (response.status === 403) {
        const reply = await readReply(response);
        if (reply && typeof reply === "object" && "refused" in reply && reply.refused === true)
          throw new CredentialsRefused();
        throw unavailable();
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw unavailable();
      }
      return response;
    } catch (error) {
      if (error instanceof CredentialsRefused) throw error;
      throw unavailable();
    }
  }
  return {
    async mint(config: IssuerConfig, row: WorkspaceLeaseRow) {
      const a = row.managedAuthority;
      const response = await post(config, {
        operation: "mint",
        request_id: row.requestId,
        session_id: a?.sessionId ?? row.workspaceId,
        generation: a?.generation ?? (row.purpose === "setup-issuer" ? 1 : 2),
        profile: a?.profile ?? null,
        owner: a?.owner ?? row.workspaceId,
        group: a?.group ?? row.workspaceId,
        slot: a?.slot ?? row.secretName,
        expires_at: row.requestExpiresAt.toISOString(),
        policy: config.policy,
      });
      const result = MintSchema.safeParse(await readReply(response));
      if (!result.success) throw unavailable();
      const expiresAt = new Date(result.data.expires_at);
      if (expiresAt <= new Date() || expiresAt > row.requestExpiresAt) throw unavailable();
      return { credential: result.data.credential, expiresAt };
    },
    async revoke(config: IssuerConfig, row: WorkspaceLeaseRow) {
      const response = await post(config, {
        operation: "revoke",
        session_id: row.managedAuthority?.sessionId ?? row.workspaceId,
        generation: row.managedAuthority?.generation ?? (row.purpose === "setup-issuer" ? 1 : 2),
      });
      await response.body?.cancel();
      if (response.status !== 200) throw unavailable();
    },
  };
}
